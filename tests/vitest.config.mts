import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	esbuild: {
		target: "esnext",
	},
	plugins: [
		cloudflareTest(async () => {
			const migrationsPath = path.join(__dirname, "..", "migrations");
			const migrations = await readD1Migrations(migrationsPath);

			return {
				wrangler: {
					configPath: "./wrangler.jsonc",
				},
				miniflare: {
					// Keep local tests aligned with the bundled workerd version until
					// Wrangler/vitest-pool-workers is upgraded to a runtime that supports
					// the production compatibility date from wrangler.jsonc.
					compatibilityDate: "2026-04-01",
					bindings: {
						MIGRATIONS: migrations,
						// Test credentials — these only exist inside miniflare.
						CF_API_TOKEN: "test-api-token",
						CF_ZONE_ID: "test-zone-id",
						DDNS_SHARED_SECRET: "test-secret",
						DDNS_ALLOWED_HOSTNAMES: "nas.example.com,home.example.com",
						DDNS_PROXIED: "false",
						DDNS_TTL: "1",
						DDNS_LOG_RETENTION_DAYS: "30",
						DDNS_RATE_LIMIT_MAX_REQUESTS: "10",
						DDNS_RATE_LIMIT_WINDOW_SECONDS: "60",
					},
				},
			};
		}),
	],
	test: {
		// Run one worker at a time in local tests. This reduces pressure on the
		// bundled workerd/Miniflare runtime while we are pinned to an older local
		// engine than the production compatibility date.
		maxWorkers: 1,
		setupFiles: ["./tests/apply-migrations.ts"],
	},
});
