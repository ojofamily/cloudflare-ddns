/**
 * Shared test utilities for mocking the Cloudflare DNS API.
 *
 * The mock intercepts outbound `fetch()` calls to `api.cloudflare.com`
 * and maintains an in-memory record store so tests can exercise the
 * worker's DNS update logic without real API calls.
 */

import type { DnsRecord } from "../src/cloudflare-api";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

interface MockDnsState {
	records: Map<string, DnsRecord>;
	nextId: number;
}

/**
 * Create an in-memory mock of the Cloudflare DNS Records API.
 *
 * Call `install()` in `beforeEach` and `restore()` in `afterEach`.
 * Use `seedRecord()` to set up existing records for a test case.
 */
export function createMockDnsApi() {
	const state: MockDnsState = { records: new Map(), nextId: 1 };
	const originalFetch = globalThis.fetch;

	function seedRecord(record: DnsRecord) {
		state.records.set(record.id, record);
	}

	function reset() {
		state.records.clear();
		state.nextId = 1;
	}

	const mockFetch = async (
		input: string | Request | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url;
		const method =
			init?.method?.toUpperCase() ??
			(typeof input === "object" && "method" in input
				? (input as Request).method.toUpperCase()
				: "GET");

		// Pass through anything that is not directed at the Cloudflare API.
		if (!url.startsWith(CF_API_BASE)) {
			return originalFetch(input, init as RequestInit);
		}

		// GET /zones/{zone_id}/dns_records?type=...&name.exact=...
		if (method === "GET" && url.includes("/dns_records")) {
			const parsed = new URL(url);
			const type = parsed.searchParams.get("type");
			const name = parsed.searchParams.get("name.exact") ?? parsed.searchParams.get("name");

			const results = [...state.records.values()].filter(
				(r) => r.type === type && r.name === name,
			);

			return Response.json({
				success: true,
				result: results,
				result_info: { page: 1, per_page: 100, count: results.length, total_count: results.length },
				errors: [],
			});
		}

		// POST /zones/{zone_id}/dns_records
		if (method === "POST" && url.endsWith("/dns_records")) {
			const body = JSON.parse(init?.body as string);
			const id = `rec-${state.nextId++}`;
			const record: DnsRecord = { id, ...body };
			state.records.set(id, record);
			return Response.json({ success: true, result: record, errors: [] });
		}

		// PATCH /zones/{zone_id}/dns_records/{id}
		// PUT  /zones/{zone_id}/dns_records/{id}
		if ((method === "PATCH" || method === "PUT") && url.includes("/dns_records/")) {
			const id = url.split("/dns_records/")[1].split("?")[0];
			const body = JSON.parse(init?.body as string);
			const existing = state.records.get(id);
			if (!existing) {
				return Response.json(
					{
						success: false,
						result: null,
						errors: [{ code: 81044, message: "Record not found" }],
					},
					{ status: 404 },
				);
			}
			const updated: DnsRecord = { ...existing, ...body };
			state.records.set(id, updated);
			return Response.json({ success: true, result: updated, errors: [] });
		}

		return Response.json(
			{ success: false, errors: [{ code: 0, message: "Unknown API route" }] },
			{ status: 404 },
		);
	};

	return {
		state,
		seedRecord,
		reset,
		install: () => {
			globalThis.fetch = mockFetch as typeof fetch;
		},
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

export async function dropLogSchema(db: D1Database): Promise<void> {
	await db.prepare("DROP INDEX IF EXISTS idx_ddns_logs_created_at").run();
	await db.prepare("DROP TABLE IF EXISTS ddns_logs").run();
}

export async function clearRuntimeTables(db: D1Database): Promise<void> {
	for (const statement of [
		"DELETE FROM ddns_logs",
		"DELETE FROM ddns_rate_limits",
	]) {
		try {
			await db.prepare(statement).run();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("no such table")) {
				throw error;
			}
		}
	}
}

export async function dropRateLimitSchema(db: D1Database): Promise<void> {
	await db.prepare("DROP INDEX IF EXISTS idx_ddns_rate_limits_updated_at").run();
	await db.prepare("DROP TABLE IF EXISTS ddns_rate_limits").run();
}

/** Build a Synology-style update URL with sensible defaults. */
export function makeSynologyUrl(
	overrides: {
		hostname?: string;
		myip?: string;
		username?: string;
		password?: string;
	} = {},
): string {
	const params = new URLSearchParams({
		hostname: overrides.hostname ?? "nas.example.com",
		myip: overrides.myip ?? "1.2.3.4",
		username: overrides.username ?? "ddns",
		password: overrides.password ?? "test-secret",
	});
	return `http://localhost/nic/update?${params}`;
}
