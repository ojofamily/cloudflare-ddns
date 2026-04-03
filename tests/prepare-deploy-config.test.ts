// @vitest-environment node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { prepareDeployConfig } from "../scripts/prepare-deploy-config";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDeployDir = path.join(projectRoot, ".wrangler", "deploy");
const generatedConfigPath = path.join(generatedDeployDir, "wrangler.generated.jsonc");
const redirectConfigPath = path.join(generatedDeployDir, "config.json");

const D1_DATABASE_ID_ENV = "DDNS_D1_DATABASE_ID";
const TEST_DATABASE_ID = "123e4567-e89b-12d3-a456-426614174000";

async function clearGeneratedDeployConfig(): Promise<void> {
	await fs.rm(generatedConfigPath, { force: true });
	await fs.rm(redirectConfigPath, { force: true });
	await fs.rm(generatedDeployDir, { recursive: true, force: true });
}

describe("prepareDeployConfig", () => {
	afterEach(async () => {
		delete process.env[D1_DATABASE_ID_ENV];
		await clearGeneratedDeployConfig();
	});

	it("rewrites the generated main entrypoint relative to .wrangler/deploy", async () => {
		process.env[D1_DATABASE_ID_ENV] = TEST_DATABASE_ID;

		await expect(prepareDeployConfig()).resolves.toBe(true);

		const generatedConfig = JSON.parse(await fs.readFile(generatedConfigPath, "utf8")) as {
			main?: string;
			d1_databases?: Array<{ database_id?: string }>;
		};

		expect(generatedConfig.main).toBe("../../src/index.ts");
		expect(generatedConfig.d1_databases?.[0]?.database_id).toBe(TEST_DATABASE_ID);
	});
});