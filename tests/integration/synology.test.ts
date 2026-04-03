import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearRuntimeTables, createMockDnsApi, dropLogSchema, makeSynologyUrl } from "../helpers";

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

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("GET /nic/update — authentication", () => {
	it("returns badauth when password is missing", async () => {
		const response = await SELF.fetch(makeSynologyUrl({ password: "" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("badauth");
	});

	it("returns badauth when password is wrong", async () => {
		const response = await SELF.fetch(makeSynologyUrl({ password: "wrong-secret" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("badauth");
	});

	it("returns 429 and 911 when a client exceeds the fixed-window rate limit", async () => {
		setRateLimitConfig("2");
		const headers = { "CF-Connecting-IP": "198.51.100.201" };

		expect((await SELF.fetch(makeSynologyUrl(), { headers })).status).toBe(200);
		expect((await SELF.fetch(makeSynologyUrl(), { headers })).status).toBe(200);

		const response = await SELF.fetch(makeSynologyUrl(), { headers });
		expect(response.status).toBe(429);
		expect(await response.text()).toBe("911");
		expect(response.headers.get("Retry-After")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Hostname validation
// ---------------------------------------------------------------------------

describe("GET /nic/update — hostname validation", () => {
	it("returns nohost when hostname is missing", async () => {
		const response = await SELF.fetch(makeSynologyUrl({ hostname: "" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("nohost");
	});

	it("returns nohost when hostname is not in the allowed list", async () => {
		const response = await SELF.fetch(makeSynologyUrl({ hostname: "evil.example.com" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("nohost");
	});
});

// ---------------------------------------------------------------------------
// DNS record creation
// ---------------------------------------------------------------------------

describe("GET /nic/update — record creation", () => {
	it("creates a new A record and returns good", async () => {
		const response = await SELF.fetch(makeSynologyUrl({ myip: "203.0.113.1" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("good 203.0.113.1");

		// Verify the record was created in the mock store.
		const record = [...dns.state.records.values()].find(
			(r) => r.name === "nas.example.com",
		);
		expect(record).toBeDefined();
		expect(record!.content).toBe("203.0.113.1");
		expect(record!.type).toBe("A");
	});

	it("creates an AAAA record for IPv6 addresses", async () => {
		const response = await SELF.fetch(makeSynologyUrl({ myip: "2001:db8::1" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("good 2001:db8::1");

		const record = [...dns.state.records.values()].find(
			(r) => r.name === "nas.example.com" && r.type === "AAAA",
		);
		expect(record).toBeDefined();
		expect(record!.content).toBe("2001:db8::1");
	});

	it("updates an explicit wildcard companion record when configured", async () => {
		setAllowedHostnames("nas.example.com,*.nas.example.com,home.example.com");

		const response = await SELF.fetch(makeSynologyUrl({ myip: "203.0.113.10" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("good 203.0.113.10");

		expect([...dns.state.records.values()].map((record) => record.name).sort()).toEqual([
			"*.nas.example.com",
			"nas.example.com",
		]);
	});
});

// ---------------------------------------------------------------------------
// DNS record update
// ---------------------------------------------------------------------------

describe("GET /nic/update — record updates", () => {
	it("returns nochg when IP already matches", async () => {
		dns.seedRecord({
			id: "existing-1",
			type: "A",
			name: "nas.example.com",
			content: "203.0.113.1",
			proxied: false,
			ttl: 1,
		});

		const response = await SELF.fetch(makeSynologyUrl({ myip: "203.0.113.1" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("nochg 203.0.113.1");
	});

	it("updates existing record when IP changes", async () => {
		dns.seedRecord({
			id: "existing-2",
			type: "A",
			name: "nas.example.com",
			content: "203.0.113.1",
			proxied: false,
			ttl: 1,
		});

		const response = await SELF.fetch(makeSynologyUrl({ myip: "203.0.113.99" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("good 203.0.113.99");

		const updated = dns.state.records.get("existing-2");
		expect(updated!.content).toBe("203.0.113.99");
	});
});

// ---------------------------------------------------------------------------
// D1 logging
// ---------------------------------------------------------------------------

describe("GET /nic/update — D1 logging", () => {
	it("writes a log row on successful update", async () => {
		await SELF.fetch(makeSynologyUrl({ myip: "198.51.100.1" }));

		// Give the waitUntil promise a tick to settle.
		await new Promise((r) => setTimeout(r, 50));

		const { results } = await env.DB.prepare(
			"SELECT * FROM ddns_logs ORDER BY id DESC LIMIT 1",
		).all();

		expect(results.length).toBe(1);
		expect(results[0].hostname).toBe("nas.example.com");
		expect(results[0].ip).toBe("198.51.100.1");
		expect(results[0].action).toBe("created");
		expect(results[0].source).toBe("synology");
	});

	it("recreates the log schema on first write when the table is missing", async () => {
		await dropLogSchema(env.DB);

		const response = await SELF.fetch(makeSynologyUrl({ myip: "198.51.100.25" }));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("good 198.51.100.25");

		await new Promise((r) => setTimeout(r, 50));

		const { results } = await env.DB.prepare(
			"SELECT hostname, ip, action, source FROM ddns_logs ORDER BY id DESC LIMIT 1",
		).all();

		expect(results).toHaveLength(1);
		expect(results[0].hostname).toBe("nas.example.com");
		expect(results[0].ip).toBe("198.51.100.25");
		expect(results[0].action).toBe("created");
		expect(results[0].source).toBe("synology");
	});
});

// ---------------------------------------------------------------------------
// Second allowed hostname
// ---------------------------------------------------------------------------

describe("GET /nic/update — multiple allowed hostnames", () => {
	it("accepts the second hostname in the allowed list", async () => {
		const response = await SELF.fetch(
			makeSynologyUrl({ hostname: "home.example.com", myip: "10.0.0.1" }),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("good 10.0.0.1");
	});
});
