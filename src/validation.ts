/**
 * Pure validation and config-parsing helpers.
 *
 * IP validation uses Zod v4's built-in `z.ipv4()` / `z.ipv6()` validators.
 * Config-parsing helpers remain hand-written because their clamping/fallback
 * semantics don't map to a simpler Zod form.
 */

import { z } from "zod";

/** Zod schema for a valid IPv4 address string. */
export const Ipv4Schema = z.ipv4();

/** Zod schema for a valid IPv6 address string. */
export const Ipv6Schema = z.ipv6();

/** Zod schema accepting either a valid IPv4 or IPv6 address. */
export const IpAddressSchema = z.union([z.ipv4(), z.ipv6()]);

/** Returns `true` if `value` is a valid IPv4 address. */
export function isIpv4(value: string): boolean {
	return Ipv4Schema.safeParse(value).success;
}

/** Returns `true` if `value` is a valid IPv6 address. */
export function isIpv6(value: string): boolean {
	return Ipv6Schema.safeParse(value).success;
}

/** Returns `true` for either a valid IPv4 or IPv6 address string. */
export function isIpAddress(value: string): boolean {
	return IpAddressSchema.safeParse(value).success;
}

/**
 * Determine which DNS record type to use for an IP address.
 * IPv4 addresses map to `A` records, IPv6 to `AAAA`.
 */
export function detectRecordType(ip: string): "A" | "AAAA" {
	return ip.includes(":") ? "AAAA" : "A";
}

/**
 * Parse a string boolean from an environment variable.
 * Recognizes `"true"` and `"false"` (case-insensitive, trimmed).
 * Returns `fallback` for any unrecognized or missing value.
 */
export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (!value) return fallback;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return fallback;
}

/**
 * Parse a TTL value from an environment variable.
 *
 * Cloudflare DNS accepts TTL `1` (automatic) or a value in 60-86400 seconds.
 * Returns `1` for missing, non-numeric, or out-of-range input.
 */
export function parseTtl(value: string | undefined): number {
	if (!value) return 1;
	const ttl = Number.parseInt(value, 10);
	if (!Number.isFinite(ttl)) return 1;
	if (ttl === 1) return 1;
	if (ttl < 60) return 60;
	if (ttl > 86400) return 86400;
	return ttl;
}

function parseIntegerInRange(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed < minimum) return minimum;
	if (parsed > maximum) return maximum;
	return parsed;
}

export function parseRateLimitMaxRequests(value: string | undefined): number {
	return parseIntegerInRange(value, 10, 0, 1000);
}

export function parseRateLimitWindowSeconds(value: string | undefined): number {
	return parseIntegerInRange(value, 60, 1, 3600);
}

/**
 * Split a comma-separated hostname list into a normalized array.
 * Each entry is trimmed and lowercased. Empty entries are dropped.
 */
export function parseAllowedHostnames(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((h) => h.trim().toLowerCase())
		.filter((h) => h.length > 0);
}

/**
 * Pick the default hostname for requests that omit one.
 *
 * Prefer an exact hostname over a wildcard companion so a config like
 * `nas.example.com,*.nas.example.com` defaults to the exact record.
 */
export function getDefaultHostname(allowedHostnames: string[]): string | undefined {
	return allowedHostnames.find((hostname) => !hostname.startsWith("*.")) ?? allowedHostnames[0];
}

/**
 * Resolve the concrete DNS records that should be updated for a request.
 *
 * A request for an exact allowed hostname also updates its explicit wildcard
 * companion when `*.${hostname}` is present in the allowlist.
 */
export function resolveUpdateHostnames(
	hostname: string,
	allowedHostnames: string[],
): string[] {
	const normalizedHostname = hostname.trim().toLowerCase();
	if (!normalizedHostname) return [];

	const allowedSet = new Set(allowedHostnames);
	if (!allowedSet.has(normalizedHostname)) return [];

	const targets = [normalizedHostname];
	if (!normalizedHostname.startsWith("*.")) {
		const wildcardCompanion = `*.${normalizedHostname}`;
		if (allowedSet.has(wildcardCompanion)) {
			targets.push(wildcardCompanion);
		}
	}

	return targets;
}
