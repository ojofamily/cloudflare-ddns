import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
	it("returns ok: true", async () => {
		const response = await SELF.fetch("http://localhost/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});
});

describe("GET /openapi.json", () => {
	it("documents both DDNS update endpoints", async () => {
		const response = await SELF.fetch("http://localhost/openapi.json");
		expect(response.status).toBe(200);
		const schema = await response.json<{
			paths: Record<string, Record<string, unknown>>;
		}>();

		expect(schema.paths["/update"]?.post).toBeDefined();
		expect(schema.paths["/nic/update"]?.get).toBeDefined();
	});
});
