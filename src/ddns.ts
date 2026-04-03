/**
 * Shared DDNS update logic used by both the Synology-compatible GET
 * endpoint and the JSON POST endpoint.
 *
 * Callers resolve authentication, hostname, and IP before calling
 * `performDdnsUpdate`. This module handles the Cloudflare DNS API
 * interaction and returns a discriminated result that each endpoint
 * can translate to its own response format.
 */

import type { DdnsEnv } from "./types";
import { UPDATE_ACTION } from "./types";
import { createRecord, findRecord, updateRecord } from "./cloudflare-api";
import { detectRecordType, parseBoolean, parseTtl } from "./validation";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DdnsUpdateSuccess {
	action: "created" | "updated" | "noop";
	ip: string;
	record_type: "A" | "AAAA";
	record_id?: string;
}

export interface DdnsUpdateError {
	action: "error";
	ip: string;
	record_type: "A" | "AAAA";
	message: string;
}

export type DdnsUpdateResult = DdnsUpdateSuccess | DdnsUpdateError;

export type DdnsTargetUpdateResult =
	| ({ hostname: string } & DdnsUpdateSuccess)
	| ({ hostname: string } & DdnsUpdateError);

export interface DdnsBatchUpdateResult {
	action: "created" | "updated" | "noop" | "error";
	ip: string;
	record_type: "A" | "AAAA";
	record_id?: string;
	results: DdnsTargetUpdateResult[];
}

// ---------------------------------------------------------------------------
// Core update
// ---------------------------------------------------------------------------

/**
 * Look up, compare, and (if needed) create or patch the DNS record for
 * `hostname` so it points at `ip`.
 *
 * Returns a result the caller can map to its response format. Never
 * throws; Cloudflare API errors are caught and returned as
 * `{ action: "error" }`.
 */
export async function performDdnsUpdate(
	env: DdnsEnv,
	hostname: string,
	ip: string,
): Promise<DdnsUpdateResult> {
	const recordType = detectRecordType(ip);
	const proxied = parseBoolean(env.DDNS_PROXIED, false);
	const ttl = parseTtl(env.DDNS_TTL);
	const comment = "managed-by:cloudflare-ddns";

	try {
		const existing = await findRecord(env, hostname, recordType);

		if (
			existing &&
			existing.content === ip &&
			Boolean(existing.proxied) === proxied &&
			(existing.ttl ?? 1) === ttl
		) {
			return {
				action: UPDATE_ACTION.NOOP,
				ip,
				record_type: recordType,
				record_id: existing.id,
			};
		}

		const payload = { type: recordType, name: hostname, content: ip, ttl, proxied, comment };

		if (existing) {
			const updated = await updateRecord(env, existing.id, payload);
			return {
				action: UPDATE_ACTION.UPDATED,
				ip,
				record_type: recordType,
				record_id: updated.id,
			};
		}

		const created = await createRecord(env, payload);
		return {
			action: UPDATE_ACTION.CREATED,
			ip,
			record_type: recordType,
			record_id: created.id,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { action: UPDATE_ACTION.ERROR, ip, record_type: recordType, message };
	}
}

function summarizeBatchAction(results: DdnsTargetUpdateResult[]): DdnsBatchUpdateResult["action"] {
	if (results.some((result) => result.action === UPDATE_ACTION.ERROR)) {
		return UPDATE_ACTION.ERROR;
	}

	if (results.every((result) => result.action === UPDATE_ACTION.NOOP)) {
		return UPDATE_ACTION.NOOP;
	}

	if (results.length === 1) {
		return results[0].action;
	}

	if (results.every((result) => result.action === UPDATE_ACTION.CREATED)) {
		return UPDATE_ACTION.CREATED;
	}

	return UPDATE_ACTION.UPDATED;
}

/**
 * Update one or more DNS records for the same IP address.
 *
 * Each hostname is updated independently. The batch result reports per-target
 * outcomes plus a summarized top-level action for the request.
 */
export async function performDdnsUpdates(
	env: DdnsEnv,
	hostnames: string[],
	ip: string,
): Promise<DdnsBatchUpdateResult> {
	const recordType = detectRecordType(ip);
	const results = await Promise.all(
		hostnames.map(async (hostname) => ({
			hostname,
			...(await performDdnsUpdate(env, hostname, ip)),
		})),
	);

	const firstSuccessfulResult = results.find((result) => result.action !== UPDATE_ACTION.ERROR);

	return {
		action: summarizeBatchAction(results),
		ip,
		record_type: recordType,
		record_id:
			firstSuccessfulResult && "record_id" in firstSuccessfulResult
				? firstSuccessfulResult.record_id
				: undefined,
		results,
	};
}
