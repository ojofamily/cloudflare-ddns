import type { DdnsEnv } from "./types";

import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { HealthEndpoint } from "./endpoints/health";
import { SynologyUpdateEndpoint } from "./endpoints/synology";
import { UpdateEndpoint } from "./endpoints/update";
import { cleanupLogs } from "./logging";
import { cleanupRateLimits } from "./rate-limit";
import { parseRateLimitWindowSeconds } from "./validation";

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: DdnsEnv }>();

app.onError((err, c) => {
	if (err instanceof ApiException) {
		return c.json(
			{ success: false, errors: err.buildResponse() },
			err.status as ContentfulStatusCode,
		);
	}

	if (err instanceof HTTPException) {
		return err.getResponse();
	}

	console.error("Unhandled error:", err);
	return c.json({ success: false, errors: [{ code: 7000, message: "Internal Server Error" }] }, 500);
});

// Chanfana OpenAPI routes.
const openapi = fromHono(app, {
	docs_url: "/",
	schema: {
		info: {
			title: "Cloudflare DDNS",
			version: "1.0.0",
			description:
				"A Cloudflare Worker that acts as a DDNS provider. " +
				"Synology NAS devices (and other clients) call this service " +
				"to keep DNS records in sync with a changing public IP address.",
		},
	},
});

openapi.get("/health", HealthEndpoint);
openapi.get("/nic/update", SynologyUpdateEndpoint);
openapi.post("/update", UpdateEndpoint);

// ---------------------------------------------------------------------------
// Scheduled handler: prune old D1 log rows
// ---------------------------------------------------------------------------

export default {
	fetch: app.fetch,

	async scheduled(
		_event: ScheduledEvent,
		env: DdnsEnv,
		ctx: ExecutionContext,
	): Promise<void> {
		const retentionDays = Number.parseInt(env.DDNS_LOG_RETENTION_DAYS ?? "30", 10) || 30;
		const rateLimitWindowSeconds = parseRateLimitWindowSeconds(env.DDNS_RATE_LIMIT_WINDOW_SECONDS);
		ctx.waitUntil(
			Promise.all([
				cleanupLogs(env.DB, retentionDays).then((deleted) => {
					if (deleted > 0) {
						console.log(`Cleaned up ${deleted} DDNS log rows older than ${retentionDays} days`);
					}
				}),
				cleanupRateLimits(env.DB, rateLimitWindowSeconds).then((deleted) => {
					if (deleted > 0) {
						console.log(`Cleaned up ${deleted} stale DDNS rate limit rows`);
					}
				}),
			]),
		);
	},
};
