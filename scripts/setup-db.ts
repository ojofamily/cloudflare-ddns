import {
	ensureWranglerAuth,
	getPrimaryD1Binding,
	info,
	isMainModule,
	isUuid,
	prompt,
	readWranglerConfig,
	runWrangler,
	step,
	outro,
	writeWranglerConfig,
} from "./common.ts";
import process from "node:process";

export async function setupDatabase(): Promise<string> {
	const config = await readWranglerConfig();
	const existingBinding = getPrimaryD1Binding(config);
	const existingId = existingBinding?.database_id;

	if (existingId && isUuid(existingId)) {
		await info(`D1 database is already configured: ${existingBinding.database_name} (${existingId})`);
		return existingId;
	}

	ensureWranglerAuth();
	await step("D1 database setup");

	const defaultName = existingBinding?.database_name || `${config.name}-db`;
	const databaseName = await prompt("D1 database name", { defaultValue: defaultName });
	const bindingName = existingBinding?.binding || "DB";
	runWrangler([
		"d1",
		"create",
		databaseName,
		"--update-config",
		"--binding",
		bindingName,
	], {
		stdio: "inherit",
	});

	const updatedConfig = await readWranglerConfig();
	const updatedBinding = getPrimaryD1Binding(updatedConfig);
	const databaseId = updatedBinding?.database_id;

	if (!databaseId || !isUuid(databaseId)) {
		throw new Error(
			"Wrangler created a database, but the updated wrangler.jsonc does not contain a valid database_id. Check the D1 binding that Wrangler wrote to the config and try again.",
		);
	}

	updatedConfig.d1_databases = [
		{
			binding: bindingName,
			database_name: databaseName,
			database_id: databaseId,
		},
	];

	await writeWranglerConfig(updatedConfig);
	console.log(`Updated wrangler.jsonc with D1 database ${databaseName} (${databaseId}).`);
	return databaseId;
}

async function main(): Promise<void> {
	await setupDatabase();
	await outro("Next: run `pnpm setup:secrets`, `pnpm run migrate:remote`, or `pnpm run deploy`.");
}

if (isMainModule(import.meta.url)) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
}