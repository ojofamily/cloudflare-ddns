/**
 * JSON API endpoint for programmatic DDNS updates.
 *
 * This Chanfana OpenAPIRoute provides a `POST /update` endpoint with
 * automatic OpenAPI documentation. It is an alternative to the
 * Synology-specific GET endpoint, useful for cron scripts or other
 * automation that prefers JSON request/response.
 */

import type { DdnsEnv, AppContext } from "../types";
import { UPDATE_ACTION } from "../types";
import { ApiException, contentJson, InputValidationException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { performDdnsUpdates } from "../ddns";
import { logUpdate } from "../logging";
import { consumeRateLimit } from "../rate-limit";
import {
	getDefaultHostname,
	isIpAddress,
	IpAddressSchema,
	parseAllowedHostnames,
	parseRateLimitMaxRequests,
	parseRateLimitWindowSeconds,
	resolveUpdateHostnames,
} from "../validation";

const UpdateBody = z.object({
	/** Hostname to update. If omitted, uses the first allowed hostname. */
	hostname: z.string().optional(),
	/**
	 * IP address to set. If omitted, the worker reads `CF-Connecting-IP`
	 * from the request headers (the caller's public IP as seen by Cloudflare).
	 */
	ip: IpAddressSchema.optional(),
});

const UpdateResponse = z.object({
	ok: z.boolean(),
	action: z.string(),
	hostname: z.string(),
	record_type: z.string(),
	ip: z.string(),
	record_id: z.string().optional(),
	results: z.array(
		z.object({
			hostname: z.string(),
			action: z.string(),
			record_type: z.string(),
			ip: z.string(),
			record_id: z.string().optional(),
			error: z.string().optional(),
		}),
	),
});

const ErrorResponse = z.object({
	success: z.boolean(),
	errors: z.array(z.object({ code: z.number(), message: z.string() })),
});

export class UpdateEndpoint extends OpenAPIRoute {
	schema = {
		tags: ["DDNS"],
		summary: "Update a DNS record with the caller's current IP",
		description:
			"Authenticate with X-DDNS-Secret header. Optionally provide hostname " +
			"and ip in the JSON body; omitted values are inferred from config and " +
			"the request's CF-Connecting-IP header.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: UpdateBody,
					},
				},
			},
			headers: z.object({
				"X-DDNS-Secret": z.string().describe("Shared secret for authentication"),
			}),
		},
		responses: {
			"200": {
				description: "DNS record update result",
				...contentJson(UpdateResponse),
			},
			"401": {
				description: "Authentication failed",
				...contentJson(ErrorResponse),
			},
			"400": {
				description: "Bad request (missing IP or invalid hostname)",
				...contentJson(ErrorResponse),
			},
		},
	};

	async handle(c: AppContext) {
		const env: DdnsEnv = c.env;
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
				return c.json(
					{
						success: false,
						errors: [{ code: 4290, message: "Rate limit exceeded" }],
					},
					429,
					{
						"Retry-After": String(rateLimit.retryAfterSeconds),
					},
				);
			}
		}

		// Authenticate via header.
		const secret = c.req.header("X-DDNS-Secret");
		if (!secret || secret !== env.DDNS_SHARED_SECRET) {
			const err = new ApiException("Unauthorized");
			err.status = 401;
			throw err;
		}

		// Parse body (Chanfana validates against the schema above).
		const data = await this.getValidatedData<typeof this.schema>();
		const body = data.body as z.infer<typeof UpdateBody>;

		// Resolve hostname.
		const allowed = parseAllowedHostnames(env.DDNS_ALLOWED_HOSTNAMES);
		const hostname = (body.hostname ?? getDefaultHostname(allowed) ?? "").trim().toLowerCase();
		const targetHostnames = resolveUpdateHostnames(hostname, allowed);

		if (!hostname || targetHostnames.length === 0) {
			throw new InputValidationException("Hostname not in allowed list");
		}

		// Resolve IP: prefer body (already validated by schema), fall back to CF-Connecting-IP.
		const ip = body.ip ?? c.req.header("CF-Connecting-IP") ?? "";

		if (!ip || !isIpAddress(ip)) {
			throw new InputValidationException("No valid IP address available");
		}

		const result = await performDdnsUpdates(env, targetHostnames, ip);

		// Log (fire-and-forget).
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
						source: "api",
					}),
				),
			),
		);

		if (result.action === UPDATE_ACTION.ERROR) {
			const failedResults = result.results.filter(
				(
					targetResult,
				): targetResult is Extract<(typeof result.results)[number], { action: "error" }> =>
					targetResult.action === UPDATE_ACTION.ERROR,
			);
			const message =
				failedResults.length === 1
					? `${failedResults[0].hostname}: ${failedResults[0].message}`
					: `Failed to update ${failedResults.length} DNS records`;
			throw new ApiException(message);
		}

		return c.json({
			ok: true,
			action: result.action,
			hostname,
			record_type: result.record_type,
			ip: result.ip,
			record_id: result.record_id,
			results: result.results.map((targetResult) => ({
				hostname: targetResult.hostname,
				action: targetResult.action,
				record_type: targetResult.record_type,
				ip: targetResult.ip,
				record_id: "record_id" in targetResult ? targetResult.record_id : undefined,
				error:
					targetResult.action === UPDATE_ACTION.ERROR ? targetResult.message : undefined,
			})),
		});
	}
}
