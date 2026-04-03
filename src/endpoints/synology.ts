/**
 * Synology-compatible DDNS endpoint.
 *
 * Synology DSM's "Customize a DDNS service provider" dialog builds a GET
 * request with these template variables substituted into the query string:
 *
 *   __HOSTNAME__  →  hostname
 *   __MYIP__      →  myip
 *   __USERNAME__  →  username
 *   __PASSWORD__  →  password
 *
 * The response body must be a DynDNS2-style status keyword that DSM can
 * parse: `good <ip>`, `nochg <ip>`, `badauth`, `nohost`, or `911`.
 */

import { OpenAPIRoute } from "chanfana";
import type { AppContext, DdnsEnv } from "../types";
import { DDNS_RESPONSE, UPDATE_ACTION } from "../types";
import { performDdnsUpdates } from "../ddns";
import { logUpdate } from "../logging";
import { consumeRateLimit } from "../rate-limit";
import {
	isIpv4,
	isIpv6,
	parseAllowedHostnames,
	parseRateLimitMaxRequests,
	parseRateLimitWindowSeconds,
	resolveUpdateHostnames,
} from "../validation";
import { z } from "zod";

const SynologyQuery = z.object({
	hostname: z
		.string()
		.nullish()
		.describe("Fully-qualified hostname to update, for example nas.example.com."),
	myip: z
		.string()
		.nullish()
		.describe("Client-supplied IPv4 or IPv6 address. Invalid values are ignored in favor of CF-Connecting-IP."),
	username: z
		.string()
		.nullish()
		.describe("Unused by this worker, but included for Synology DynDNS2 compatibility."),
	password: z.string().nullish().describe("Shared secret used to authenticate the update request."),
});

/**
 * Pick the best available IP address.
 *
 * Synology sends the NAS's detected public IP in the `myip` query param.
 * If that is missing or invalid, fall back to `CF-Connecting-IP` which
 * Cloudflare sets from the TCP connection.
 */
function pickIp(myip: string | null, cfConnectingIp: string | null): string | null {
	if (myip && (isIpv4(myip) || isIpv6(myip))) return myip;
	if (cfConnectingIp && (isIpv4(cfConnectingIp) || isIpv6(cfConnectingIp))) return cfConnectingIp;
	return null;
}

/** Plain-text response with `no-store` caching. */
function ddns(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function ddnsRateLimited(retryAfterSeconds: number): Response {
	return new Response(DDNS_RESPONSE.SERVER_ERROR, {
		status: 429,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"Retry-After": String(retryAfterSeconds),
		},
	});
}

/**
 * Handle `GET /nic/update` for Synology DSM custom DDNS providers.
 *
 * Query URL configured in DSM:
 * ```
 * https://<worker>.workers.dev/nic/update?hostname=__HOSTNAME__&myip=__MYIP__&username=__USERNAME__&password=__PASSWORD__
 * ```
 */

export class SynologyUpdateEndpoint extends OpenAPIRoute {
	schema = {
		tags: ["DDNS"],
		summary: "Synology DynDNS2 update endpoint",
		description:
			"Plain-text DynDNS2-compatible endpoint for Synology DSM and similar clients. " +
			"Returns text/plain responses such as `good <ip>`, `nochg <ip>`, `badauth`, `nohost`, or `911`.",
		request: {
			query: SynologyQuery,
		},
		responses: {
			"200": {
				description: "DynDNS2 plain-text status response",
				content: {
					"text/plain": {
						schema: z.string(),
					},
				},
			},
			"500": {
				description: "Server-side error returned as DynDNS2 status text",
				content: {
					"text/plain": {
						schema: z.string(),
					},
				},
			},
		},
	};

	async handle(c: AppContext): Promise<Response> {
		const env: DdnsEnv = c.env;

		try {
			const clientIp = c.req.header("CF-Connecting-IP")?.trim();
			const maxRequests = parseRateLimitMaxRequests(env.DDNS_RATE_LIMIT_MAX_REQUESTS);
			if (clientIp && maxRequests > 0) {
				const rateLimit = await consumeRateLimit(
					env.DB,
					`ddns-update:${clientIp}`,
					maxRequests,
					parseRateLimitWindowSeconds(env.DDNS_RATE_LIMIT_WINDOW_SECONDS),
				);

				if (!rateLimit.allowed) {
					return ddnsRateLimited(rateLimit.retryAfterSeconds);
				}
			}

			const data = await this.getValidatedData<typeof this.schema>();
			const query = data.query as z.infer<typeof SynologyQuery>;
			const hostname = (query.hostname ?? "").trim().toLowerCase();
			const myip = (query.myip ?? "").trim();
			const password = (query.password ?? "").trim();

			// Authentication: shared secret must match.
			if (!password || password !== env.DDNS_SHARED_SECRET) {
				return ddns(DDNS_RESPONSE.BADAUTH);
			}

			// Hostname must be in the allowed list.
			const allowed = parseAllowedHostnames(env.DDNS_ALLOWED_HOSTNAMES);
			const targetHostnames = resolveUpdateHostnames(hostname, allowed);
			if (!hostname || targetHostnames.length === 0) {
				return ddns(DDNS_RESPONSE.NOHOST);
			}

			// Resolve the client IP: prefer the explicit myip param, fall back to
			// CF-Connecting-IP from the TCP connection.
			const ip = pickIp(myip || null, c.req.header("CF-Connecting-IP") ?? null);
			if (!ip) {
				return ddns(DDNS_RESPONSE.SERVER_ERROR, 500);
			}

			const result = await performDdnsUpdates(env, targetHostnames, ip);

			// Log the outcome (fire-and-forget via waitUntil so the response
			// is not delayed by D1 writes).
			c.executionCtx.waitUntil(
				Promise.all(
					result.results.map((targetResult) =>
						logUpdate(env.DB, {
							hostname: targetResult.hostname,
							record_type: targetResult.record_type,
							ip: targetResult.ip,
							action: targetResult.action,
							error_message:
								targetResult.action === UPDATE_ACTION.ERROR ? targetResult.message : null,
							source: "synology",
						}),
					),
				),
			);

			if (result.action === UPDATE_ACTION.ERROR) {
				return ddns(DDNS_RESPONSE.SERVER_ERROR, 500);
			}

			if (result.action === UPDATE_ACTION.NOOP) {
				return ddns(`${DDNS_RESPONSE.NOCHG} ${ip}`);
			}

			return ddns(`${DDNS_RESPONSE.GOOD} ${ip}`);
		} catch {
			return ddns(DDNS_RESPONSE.SERVER_ERROR, 500);
		}
	}
}
