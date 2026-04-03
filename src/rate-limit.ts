// The Worker may need to recreate this table lazily when rate limiting is hit
// before remote migrations have run. Migration files exist for operator and
// test workflows, but the runtime bundle cannot load SQL files from disk.
const RATE_LIMIT_SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS ddns_rate_limits (
		key               TEXT    PRIMARY KEY NOT NULL,
		window_started_at INTEGER NOT NULL,
		request_count     INTEGER NOT NULL,
		updated_at        INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_ddns_rate_limits_updated_at ON ddns_rate_limits (updated_at)",
] as const;

interface RateLimitRow {
	window_started_at: number;
	request_count: number;
}

export interface RateLimitDecision {
	allowed: boolean;
	remaining: number;
	retryAfterSeconds: number;
}

function isMissingRateLimitTableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("no such table: ddns_rate_limits");
}

async function ensureRateLimitSchema(db: D1Database): Promise<void> {
	for (const statement of RATE_LIMIT_SCHEMA_STATEMENTS) {
		await db.prepare(statement).run();
	}
}

async function readRateLimitRow(db: D1Database, key: string): Promise<RateLimitRow | null> {
	const { results } = await db
		.prepare(
			"SELECT window_started_at, request_count FROM ddns_rate_limits WHERE key = ? LIMIT 1",
		)
		.bind(key)
		.all<RateLimitRow>();

	return (results[0] as RateLimitRow | undefined) ?? null;
}

async function writeRateLimitRow(
	db: D1Database,
	key: string,
	windowStartedAt: number,
	requestCount: number,
	updatedAt: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO ddns_rate_limits (key, window_started_at, request_count, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
				window_started_at = excluded.window_started_at,
				request_count = excluded.request_count,
				updated_at = excluded.updated_at`,
		)
		.bind(key, windowStartedAt, requestCount, updatedAt)
		.run();
}

async function consumeRateLimitInternal(
	db: D1Database,
	key: string,
	maxRequests: number,
	windowSeconds: number,
	nowSeconds: number,
): Promise<RateLimitDecision> {
	const existing = await readRateLimitRow(db, key);
	const stale = !existing || nowSeconds - existing.window_started_at >= windowSeconds;
	const windowStartedAt = stale ? nowSeconds : existing.window_started_at;
	const requestCount = stale ? 1 : existing.request_count + 1;

	await writeRateLimitRow(db, key, windowStartedAt, requestCount, nowSeconds);

	const retryAfterSeconds = Math.max(1, windowStartedAt + windowSeconds - nowSeconds);

	return {
		allowed: requestCount <= maxRequests,
		remaining: Math.max(0, maxRequests - requestCount),
		retryAfterSeconds,
	};
}

export async function consumeRateLimit(
	db: D1Database,
	key: string,
	maxRequests: number,
	windowSeconds: number,
): Promise<RateLimitDecision> {
	const nowSeconds = Math.floor(Date.now() / 1000);

	try {
		return await consumeRateLimitInternal(db, key, maxRequests, windowSeconds, nowSeconds);
	} catch (error) {
		if (isMissingRateLimitTableError(error)) {
			try {
				await ensureRateLimitSchema(db);
				return await consumeRateLimitInternal(db, key, maxRequests, windowSeconds, nowSeconds);
			} catch (retryError) {
				console.error("Failed to recreate DDNS rate limit schema:", retryError);
			}
		}

		console.error("Failed to apply DDNS rate limit:", error);
		return {
			allowed: true,
			remaining: maxRequests,
			retryAfterSeconds: windowSeconds,
		};
	}
}

export async function cleanupRateLimits(db: D1Database, windowSeconds: number): Promise<number> {
	const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;

	try {
		const result = await db
			.prepare("DELETE FROM ddns_rate_limits WHERE updated_at < ?")
			.bind(cutoff)
			.run();
		return result.meta.changes ?? 0;
	} catch (error) {
		if (isMissingRateLimitTableError(error)) {
			return 0;
		}

		console.error("Failed to clean up DDNS rate limit rows:", error);
		return 0;
	}
}