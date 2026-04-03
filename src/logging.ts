/**
 * Best-effort D1-backed update logging.
 *
 * Each DDNS update attempt (success or failure) is recorded so operators
 * can audit what happened. If the `ddns_logs` table is missing, the first
 * write recreates it lazily. A scheduled cron job calls `cleanupLogs` to
 * prune rows older than the configured retention period once the schema
 * exists.
 */

import type { UpdateAction } from "./types";

// The Worker may need to recreate this table lazily on first write. Migration
// files live on disk for operator and test workflows, but the runtime bundle
// cannot read them from the filesystem inside Workers.
const LOG_SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS ddns_logs (
		id            INTEGER  PRIMARY KEY AUTOINCREMENT NOT NULL,
		created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		hostname      TEXT     NOT NULL,
		record_type   TEXT     NOT NULL,
		ip            TEXT     NOT NULL,
		action        TEXT     NOT NULL,
		error_message TEXT,
		source        TEXT     NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_ddns_logs_created_at ON ddns_logs (created_at)",
] as const;

/** Shape of a row in the `ddns_logs` table. */
export interface DdnsLogEntry {
	hostname: string;
	record_type: string;
	ip: string;
	action: UpdateAction;
	error_message: string | null;
	source: "synology" | "api";
}

function isMissingLogTableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("no such table: ddns_logs");
}

async function ensureLogSchema(db: D1Database): Promise<void> {
	for (const statement of LOG_SCHEMA_STATEMENTS) {
		await db.prepare(statement).run();
	}
}

/**
 * Insert a single update log row into D1.
 *
 * Failures are intentionally swallowed (logged to console) so that a
 * missing table, failed migration, or transient D1 hiccup does not
 * prevent the DNS update response from reaching the caller.
 */
export async function logUpdate(db: D1Database, entry: DdnsLogEntry): Promise<void> {
	try {
		await db
			.prepare(
				`INSERT INTO ddns_logs (hostname, record_type, ip, action, error_message, source)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				entry.hostname,
				entry.record_type,
				entry.ip,
				entry.action,
				entry.error_message,
				entry.source,
			)
			.run();
	} catch (err) {
		if (isMissingLogTableError(err)) {
			try {
				await ensureLogSchema(db);
				await db
					.prepare(
						`INSERT INTO ddns_logs (hostname, record_type, ip, action, error_message, source)
						 VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						entry.hostname,
						entry.record_type,
						entry.ip,
						entry.action,
						entry.error_message,
						entry.source,
					)
					.run();
				return;
			} catch (retryError) {
				console.error("Failed to recreate DDNS log schema:", retryError);
			}
		}

		console.error("Failed to write DDNS log entry:", err);
	}
}

/**
 * Delete log rows older than `retentionDays` days.
 * Returns the number of deleted rows, or 0 if cleanup is unavailable.
 */
export async function cleanupLogs(db: D1Database, retentionDays: number): Promise<number> {
	try {
		const result = await db
			.prepare(`DELETE FROM ddns_logs WHERE created_at < datetime('now', ? || ' days')`)
			.bind(-retentionDays)
			.run();
		return result.meta.changes ?? 0;
	} catch (err) {
		if (isMissingLogTableError(err)) {
			return 0;
		}

		console.error("Failed to clean up DDNS logs:", err);
		return 0;
	}
}
