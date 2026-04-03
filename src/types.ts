import type { Context } from "hono";

/**
 * Worker environment bindings.
 *
 * Secrets (`CF_API_TOKEN`, `CF_ZONE_ID`, `DDNS_SHARED_SECRET`) are set via
 * `wrangler secret put`. Non-secret runtime configuration such as
 * `DDNS_ALLOWED_HOSTNAMES` lives in `wrangler.jsonc` `vars`.
 *
 * The generated `worker-configuration.d.ts` provides the global `Env` with
 * the D1 binding. This interface extends it with the DDNS-specific variables
 * so handler code gets full type coverage.
 */
export interface DdnsEnv extends Env {
	/** Cloudflare API token with DNS:Edit permission for the target zone. */
	CF_API_TOKEN: string;
	/** Cloudflare zone ID that owns the hostnames being updated. */
	CF_ZONE_ID: string;
	/** Shared secret that callers must provide to authenticate updates. */
	DDNS_SHARED_SECRET: string;
	/**
	 * Comma-separated list of hostnames this worker is allowed to update.
	 * This is ordinary config, not a secret, because it is an allowlist rather
	 * than a credential.
	 *
	 * @example "nas.example.com,home.example.com"
	 */
	DDNS_ALLOWED_HOSTNAMES: string;
	/**
	 * Whether created/updated records should be proxied through Cloudflare.
	 * `"true"` or `"false"`. Defaults to `"false"` (DNS-only) because most
	 * NAS use cases need direct IP access on non-standard ports.
	 */
	DDNS_PROXIED: string;
	/**
	 * DNS record TTL in seconds. `"1"` means automatic (Cloudflare chooses).
	 * Valid range is 60-86400 or 1 for auto. Defaults to `"1"`.
	 */
	DDNS_TTL: string;
	/**
	 * How many days of update logs to keep in D1 before the scheduled
	 * cleanup job deletes them. Defaults to `"30"`.
	 */
	DDNS_LOG_RETENTION_DAYS: string;
	/**
	 * Maximum number of update requests allowed per client IP within the
	 * current fixed window. Set to `"0"` to disable rate limiting.
	 * Defaults to `"10"`.
	 */
	DDNS_RATE_LIMIT_MAX_REQUESTS: string;
	/**
	 * Fixed window size, in seconds, used for per-client DDNS rate limits.
	 * Defaults to `"60"`.
	 */
	DDNS_RATE_LIMIT_WINDOW_SECONDS: string;
}

/** Hono context typed with the DDNS environment bindings. */
export type AppContext = Context<{ Bindings: DdnsEnv }>;

/**
 * DynDNS-style response codes returned by the Synology-compatible endpoint.
 *
 * Synology DSM parses the response body for one of these keywords to decide
 * whether the update succeeded. The codes follow the DynDNS2 protocol that
 * most consumer DDNS providers and Synology custom providers expect.
 */
export const DDNS_RESPONSE = {
	/** Record created or updated successfully. Body: `good <ip>` */
	GOOD: "good",
	/** Record already has the correct value. Body: `nochg <ip>` */
	NOCHG: "nochg",
	/** Authentication failed (bad secret or username). */
	BADAUTH: "badauth",
	/** Hostname is not in the allowed list. */
	NOHOST: "nohost",
	/** Server-side error. */
	SERVER_ERROR: "911",
} as const;

export type DdnsResponse = (typeof DDNS_RESPONSE)[keyof typeof DDNS_RESPONSE];

/**
 * Actions recorded in the `ddns_logs` D1 table.
 * Each update attempt produces exactly one of these outcomes.
 */
export const UPDATE_ACTION = {
	CREATED: "created",
	UPDATED: "updated",
	NOOP: "noop",
	ERROR: "error",
} as const;

export type UpdateAction = (typeof UPDATE_ACTION)[keyof typeof UPDATE_ACTION];
