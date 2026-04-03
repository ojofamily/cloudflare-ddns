import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearRuntimeTables, createMockDnsApi, dropLogSchema } from "../helpers";

const dns = createMockDnsApi();
const DEFAULT_ALLOWED_HOSTNAMES = "nas.example.com,home.example.com";

function setAllowedHostnames(value: string) {
	Object.assign(env, { DDNS_ALLOWED_HOSTNAMES: value });
}

function setRateLimitConfig(maxRequests: string, windowSeconds = "60") {
	Object.assign(env, {
		DDNS_RATE_LIMIT_MAX_REQUESTS: maxRequests,
		DDNS_RATE_LIMIT_WINDOW_SECONDS: windowSeconds,
	});
}

beforeEach(() => {
	setAllowedHostnames(DEFAULT_ALLOWED_HOSTNAMES);
	setRateLimitConfig("10");
	dns.reset();
	dns.install();
});


beforeEach(async () => {
	await clearRuntimeTables(env.DB);
});

afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
	await clearRuntimeTables(env.DB);
	dns.restore();
});

/** Build a POST /update request with sensible defaults. */
function makeUpdateRequest(
	overrides: {
		secret?: string | null;
		hostname?: string;
		ip?: string;
		cfConnectingIp?: string;
	} = {},
): Request {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (overrides.secret !== null) {
		headers["X-DDNS-Secret"] = overrides.secret ?? "test-secret";
	}
	if (overrides.cfConnectingIp) {
		headers["CF-Connecting-IP"] = overrides.cfConnectingIp;
	}

	const body: Record<string, string> = {};
	if (overrides.hostname !== undefined) body.hostname = overrides.hostname;
	if (overrides.ip !== undefined) body.ip = overrides.ip;

	return new Request("http://localhost/update", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("POST /update — authentication", () => {
	it("returns 401 when secret header is missing", async () => {
		const response = await SELF.fetch(makeUpdateRequest({ secret: null, ip: "1.2.3.4" }));
		expect(response.status).toBe(401);
		const json = await response.json<{ success: boolean }>();
		expect(json.success).toBe(false);
	});

	it("returns 401 when secret is wrong", async () => {
		const response = await SELF.fetch(makeUpdateRequest({ secret: "wrong", ip: "1.2.3.4" }));
		expect(response.status).toBe(401);
	});

	it("returns 429 when a client exceeds the fixed-window rate limit", async () => {
		setRateLimitConfig("2");

		const request = () =>
			makeUpdateRequest({
				ip: "1.2.3.4",
				cfConnectingIp: "198.51.100.200",
			});
		expect((await SELF.fetch(request())).status).toBe(200);
		expect((await SELF.fetch(request())).status).toBe(200);

		const response = await SELF.fetch(request());
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Hostname validation
// ---------------------------------------------------------------------------

describe("POST /update — hostname validation", () => {
	it("returns 400 for disallowed hostname", async () => {
		const response = await SELF.fetch(
			makeUpdateRequest({ hostname: "evil.example.com", ip: "1.2.3.4" }),
		);
		expect(response.status).toBe(400);
		const json = await response.json<{ errors: Array<{ message: string }> }>();
		expect(json.errors[0].message).toContain("Hostname");
	});

	it("defaults to the first allowed hostname when omitted", async () => {
		const response = await SELF.fetch(makeUpdateRequest({ ip: "198.51.100.5" }));
		expect(response.status).toBe(200);
		const json = await response.json<{ hostname: string }>();
		expect(json.hostname).toBe("nas.example.com");
	});
});

// ---------------------------------------------------------------------------
// IP resolution
// ---------------------------------------------------------------------------

describe("POST /update — IP resolution", () => {
	it("returns 400 when no IP is available", async () => {
		const response = await SELF.fetch(makeUpdateRequest({}));
		expect(response.status).toBe(400);
		const json = await response.json<{ errors: Array<{ message: string }> }>();
		expect(json.errors[0].message).toContain("IP");
	});

	it("uses CF-Connecting-IP when body IP is omitted", async () => {
		const response = await SELF.fetch(
			makeUpdateRequest({ cfConnectingIp: "198.51.100.10" }),
		);
		expect(response.status).toBe(200);
		const json = await response.json<{ ip: string }>();
		expect(json.ip).toBe("198.51.100.10");
	});

	it("prefers body IP over CF-Connecting-IP", async () => {
		const response = await SELF.fetch(
			makeUpdateRequest({ ip: "10.0.0.1", cfConnectingIp: "10.0.0.2" }),
		);
		expect(response.status).toBe(200);
		const json = await response.json<{ ip: string }>();
		expect(json.ip).toBe("10.0.0.1");
	});
});

// ---------------------------------------------------------------------------
// DNS record lifecycle
// ---------------------------------------------------------------------------

describe("POST /update — DNS updates", () => {
	it("creates a new record", async () => {
		const response = await SELF.fetch(makeUpdateRequest({ ip: "203.0.113.1" }));
		expect(response.status).toBe(200);
		const json = await response.json<{
			ok: boolean;
			action: string;
			record_type: string;
		}>();
		expect(json.ok).toBe(true);
		expect(json.action).toBe("created");
		expect(json.record_type).toBe("A");
	});

	it("returns noop when record is unchanged", async () => {
		dns.seedRecord({
			id: "rec-existing",
			type: "A",
			name: "nas.example.com",
			content: "203.0.113.1",
			proxied: false,
			ttl: 1,
		});

		const response = await SELF.fetch(makeUpdateRequest({ ip: "203.0.113.1" }));
		expect(response.status).toBe(200);
		const json = await response.json<{ action: string }>();
		expect(json.action).toBe("noop");
	});

	it("updates existing record when IP changes", async () => {
		dns.seedRecord({
			id: "rec-existing",
			type: "A",
			name: "nas.example.com",
			content: "203.0.113.1",
			proxied: false,
			ttl: 1,
		});

		const response = await SELF.fetch(makeUpdateRequest({ ip: "203.0.113.99" }));
		expect(response.status).toBe(200);
		const json = await response.json<{ action: string; ip: string }>();
		expect(json.action).toBe("updated");
		expect(json.ip).toBe("203.0.113.99");
	});

	it("handles IPv6 addresses", async () => {
		const response = await SELF.fetch(makeUpdateRequest({ ip: "2001:db8::1" }));
		expect(response.status).toBe(200);
		const json = await response.json<{ record_type: string }>();
		expect(json.record_type).toBe("AAAA");
	});

	it("updates an explicit wildcard companion record when configured", async () => {
		setAllowedHostnames("nas.example.com,*.nas.example.com,home.example.com");

		const response = await SELF.fetch(makeUpdateRequest({ ip: "203.0.113.10" }));
		expect(response.status).toBe(200);
		const json = await response.json<{
			action: string;
			results: Array<{ hostname: string; action: string }>;
		}>();

		expect(json.action).toBe("created");
		expect(json.results).toHaveLength(2);
		expect(json.results.map((result: { hostname: string }) => result.hostname)).toEqual([
			"nas.example.com",
			"*.nas.example.com",
		]);
		expect([...dns.state.records.values()].map((record) => record.name).sort()).toEqual([
			"*.nas.example.com",
			"nas.example.com",
		]);
	});
});

// ---------------------------------------------------------------------------
// D1 logging
// ---------------------------------------------------------------------------

describe("POST /update — D1 logging", () => {
	it("writes a log row on successful update", async () => {
		await SELF.fetch(makeUpdateRequest({ ip: "198.51.100.1" }));

		// Give the waitUntil promise a tick to settle.
		await new Promise((r) => setTimeout(r, 50));

		const { results } = await env.DB.prepare(
			"SELECT * FROM ddns_logs ORDER BY id DESC LIMIT 1",
		).all();

		expect(results.length).toBe(1);
		expect(results[0].hostname).toBe("nas.example.com");
		expect(results[0].ip).toBe("198.51.100.1");
		expect(results[0].action).toBe("created");
		expect(results[0].source).toBe("api");
	});

	it("writes one log row per companion record update", async () => {
		setAllowedHostnames("nas.example.com,*.nas.example.com");

		await SELF.fetch(makeUpdateRequest({ ip: "198.51.100.20" }));
		await new Promise((r) => setTimeout(r, 50));

		const { results } = await env.DB.prepare(
			"SELECT hostname, action FROM ddns_logs ORDER BY hostname ASC",
		).all();

		expect(results).toHaveLength(2);
		expect(results.map((row) => row.hostname)).toEqual([
			"*.nas.example.com",
			"nas.example.com",
		]);
	});

	it("recreates the log schema on first write when the table is missing", async () => {
		await dropLogSchema(env.DB);

		const response = await SELF.fetch(makeUpdateRequest({ ip: "198.51.100.21" }));
		expect(response.status).toBe(200);

		await new Promise((r) => setTimeout(r, 50));

		const { results } = await env.DB.prepare(
			"SELECT hostname, ip, action, source FROM ddns_logs ORDER BY id DESC LIMIT 1",
		).all();

		expect(results).toHaveLength(1);
		expect(results[0].hostname).toBe("nas.example.com");
		expect(results[0].ip).toBe("198.51.100.21");
		expect(results[0].action).toBe("created");
		expect(results[0].source).toBe("api");
	});
});
