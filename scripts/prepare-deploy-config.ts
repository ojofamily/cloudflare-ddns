import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
	getPrimaryD1Binding,
	info,
	isMainModule,
	isUuid,
	readWranglerConfig,
	type WranglerConfig,
} from "./common.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedDeployDir = path.join(projectRoot, ".wrangler", "deploy");
const generatedConfigPath = path.join(generatedDeployDir, "wrangler.generated.jsonc");
const redirectConfigPath = path.join(generatedDeployDir, "config.json");

const D1_DATABASE_ID_ENV = "DDNS_D1_DATABASE_ID";
const D1_PREVIEW_DATABASE_ID_ENV = "DDNS_D1_PREVIEW_DATABASE_ID";
const REQUIRE_D1_ID_FLAG = "--require-d1-database-id";

interface PrepareDeployConfigOptions {
	requireDatabaseId?: boolean;
}

async function clearGeneratedDeployConfig(): Promise<void> {
	await fs.rm(generatedConfigPath, { force: true });
	await fs.rm(redirectConfigPath, { force: true });

	try {
		await fs.rmdir(generatedDeployDir);
	} catch {
		return;
	}
}

function getDatabaseIdFromEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function toGeneratedConfigRelativePath(configPath: string): string {
	const absolutePath = path.resolve(projectRoot, configPath);
	const relativePath = path.relative(generatedDeployDir, absolutePath);
	const normalizedPath = relativePath.split(path.sep).join("/");
	return normalizedPath.startsWith(".") ? normalizedPath : `./${normalizedPath}`;
}

function buildGeneratedConfig(config: WranglerConfig, databaseId: string, previewDatabaseId?: string): WranglerConfig {
	const binding = getPrimaryD1Binding(config);
	if (!binding) {
		throw new Error("Missing D1 binding `DB` in wrangler.jsonc.");
	}

	return {
		...config,
		...(typeof config.main === "string" ? { main: toGeneratedConfigRelativePath(config.main) } : {}),
		d1_databases: [
			{
				...binding,
				database_id: databaseId,
				...(previewDatabaseId ? { preview_database_id: previewDatabaseId } : {}),
			},
		],
	};
}

export async function prepareDeployConfig(options: PrepareDeployConfigOptions = {}): Promise<boolean> {
	const databaseId = getDatabaseIdFromEnv(D1_DATABASE_ID_ENV);
	const previewDatabaseId = getDatabaseIdFromEnv(D1_PREVIEW_DATABASE_ID_ENV);

	if (!databaseId) {
		await clearGeneratedDeployConfig();

		if (options.requireDatabaseId) {
			throw new Error(
				`${D1_DATABASE_ID_ENV} is required for this command. Set it to the real D1 database UUID when you want Wrangler to target an existing remote database.`,
			);
		}

		await info(
			`No ${D1_DATABASE_ID_ENV} set. Using the committed template-safe wrangler.jsonc without a database_id.`,
		);
		return false;
	}

	if (!isUuid(databaseId)) {
		throw new Error(`${D1_DATABASE_ID_ENV} must be a valid UUID.`);
	}

	if (previewDatabaseId && !isUuid(previewDatabaseId)) {
		throw new Error(`${D1_PREVIEW_DATABASE_ID_ENV} must be a valid UUID when set.`);
	}

	const config = await readWranglerConfig();
	const generatedConfig = buildGeneratedConfig(config, databaseId, previewDatabaseId);

	await fs.mkdir(generatedDeployDir, { recursive: true });
	await fs.writeFile(generatedConfigPath, `${JSON.stringify(generatedConfig, null, "\t")}\n`, "utf8");
	await fs.writeFile(
		redirectConfigPath,
		`${JSON.stringify({ configPath: "./wrangler.generated.jsonc" }, null, "\t")}\n`,
		"utf8",
	);

	await info(
		`Prepared generated deploy config with ${D1_DATABASE_ID_ENV}. Wrangler deploy commands will target the configured remote D1 database.`,
	);
	return true;
}

async function main(): Promise<void> {
	await prepareDeployConfig({ requireDatabaseId: process.argv.includes(REQUIRE_D1_ID_FLAG) });
}

if (isMainModule(import.meta.url)) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
}