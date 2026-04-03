/**
 * DNS record operations backed by the official Cloudflare TypeScript SDK.
 *
 * All functions accept the env bindings directly so they can read
 * `CF_API_TOKEN` and `CF_ZONE_ID` without global state.
 */

import Cloudflare from "cloudflare";

import type { DdnsEnv } from "./types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Simplified DNS record shape used throughout this worker.
 * Mapped from the SDK's discriminated `RecordResponse` union.
 */
export interface DnsRecord {
	id: string;
	type: string;
	name: string;
	content: string;
	proxied?: boolean;
	ttl?: number;
}

// ---------------------------------------------------------------------------
// DNS record operations
// ---------------------------------------------------------------------------

function createClient(env: Pick<DdnsEnv, "CF_API_TOKEN">): Cloudflare {
	return new Cloudflare({
		apiToken: env.CF_API_TOKEN,
		// Force the SDK through the runtime fetch so integration tests can stub
		// outbound API calls by replacing globalThis.fetch.
		fetch: (input, init) => globalThis.fetch(input, init),
	});
}

/**
 * Find an existing DNS record by exact hostname and type (A or AAAA).
 *
 * Uses the SDK's list method with server-side `type` and `name` filters.
 * Returns `null` when no matching record exists.
 */
export async function findRecord(
	env: Pick<DdnsEnv, "CF_API_TOKEN" | "CF_ZONE_ID">,
	hostname: string,
	type: "A" | "AAAA",
): Promise<DnsRecord | null> {
	const client = createClient(env);
	for await (const r of client.dns.records.list({
		zone_id: env.CF_ZONE_ID,
		type,
		name: { exact: hostname },
	})) {
		if (r.type === "A" || r.type === "AAAA") {
			return { id: r.id, type: r.type, name: r.name, content: r.content ?? "", proxied: r.proxied, ttl: r.ttl };
		}
	}
	return null;
}

/**
 * Create a new DNS record in the zone.
 * Returns the created record including its Cloudflare-assigned `id`.
 */
export async function createRecord(
	env: Pick<DdnsEnv, "CF_API_TOKEN" | "CF_ZONE_ID">,
	payload: {
		type: "A" | "AAAA";
		name: string;
		content: string;
		ttl: number;
		proxied: boolean;
		comment: string;
	},
): Promise<DnsRecord> {
	const client = createClient(env);
	const base = {
		zone_id: env.CF_ZONE_ID,
		name: payload.name,
		content: payload.content,
		ttl: payload.ttl,
		proxied: payload.proxied,
		comment: payload.comment,
	};
	const r =
		payload.type === "A"
			? await client.dns.records.create({ ...base, type: "A" })
			: await client.dns.records.create({ ...base, type: "AAAA" });
	if (r.type !== "A" && r.type !== "AAAA") throw new Error(`Unexpected record type: ${r.type}`);
	return { id: r.id, type: r.type, name: r.name, content: r.content ?? "", proxied: r.proxied, ttl: r.ttl };
}

/**
 * Overwrite an existing DNS record (PUT).
 * Returns the updated record.
 */
export async function updateRecord(
	env: Pick<DdnsEnv, "CF_API_TOKEN" | "CF_ZONE_ID">,
	recordId: string,
	payload: {
		type: "A" | "AAAA";
		name: string;
		content: string;
		ttl: number;
		proxied: boolean;
		comment: string;
	},
): Promise<DnsRecord> {
	const client = createClient(env);
	const base = {
		zone_id: env.CF_ZONE_ID,
		name: payload.name,
		content: payload.content,
		ttl: payload.ttl,
		proxied: payload.proxied,
		comment: payload.comment,
	};
	const r =
		payload.type === "A"
			? await client.dns.records.update(recordId, { ...base, type: "A" })
			: await client.dns.records.update(recordId, { ...base, type: "AAAA" });
	if (r.type !== "A" && r.type !== "AAAA") throw new Error(`Unexpected record type: ${r.type}`);
	return { id: r.id, type: r.type, name: r.name, content: r.content ?? "", proxied: r.proxied, ttl: r.ttl };
}
