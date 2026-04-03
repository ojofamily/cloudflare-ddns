import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	REQUIRED_SECRETS,
	ensureWranglerAuth,
	generatedSharedSecret,
	isMainModule,
	prompt,
	readWranglerConfig,
	runWrangler,
	step,
	outro,
	writeWranglerConfig,
	validateAllowedHostnamesCsv,
	validateRequiredText,
	validateSharedSecret,
	validateZoneId,
} from "./common.ts";

async function promptUntilValid(
	question: string,
	validate: (value: string) => string,
	defaultValue?: string,
): Promise<string> {
	while (true) {
		const answer = await prompt(question, { defaultValue, validate });
		const error = validate(answer);
		if (!error) return answer;
		console.error(error);
	}
}

export async function setupSecrets(): Promise<{
	apiToken: string;
	zoneId: string;
	sharedSecret: string;
	allowedHostnames: string;
}> {
	const config = await readWranglerConfig();
	ensureWranglerAuth();
	await step(`Secret setup for ${config.name}`);

	const apiToken = await promptUntilValid(
		"Cloudflare API token",
		(value) => validateRequiredText(value, "CF_API_TOKEN"),
		process.env.CF_API_TOKEN,
	);

	const zoneId = await promptUntilValid("Cloudflare zone ID", validateZoneId, process.env.CF_ZONE_ID);

	const sharedSecret = await promptUntilValid(
		"DDNS shared secret",
		validateSharedSecret,
		process.env.DDNS_SHARED_SECRET || generatedSharedSecret(),
	);

	const allowedHostnames = await promptUntilValid(
		"Allowed hostnames (comma-separated)",
		(value) => {
			const result = validateAllowedHostnamesCsv(value);
			return result.ok ? "" : result.errors.join("\n");
		},
		process.env.DDNS_ALLOWED_HOSTNAMES || "nas.example.com,*.nas.example.com",
	);

	const tempFile = path.join(os.tmpdir(), `cloudflare-ddns-secrets-${Date.now()}.env`);
	const envText = [
		`CF_API_TOKEN=${apiToken}`,
		`CF_ZONE_ID=${zoneId}`,
		`DDNS_SHARED_SECRET=${sharedSecret}`,
	].join("\n");

	config.vars = {
		...(config.vars || {}),
		DDNS_ALLOWED_HOSTNAMES: allowedHostnames,
	};
	await writeWranglerConfig(config);

	await fs.writeFile(tempFile, envText, "utf8");
	try {
		runWrangler(["secret", "bulk", tempFile], { stdio: "inherit" });
	} finally {
		await fs.rm(tempFile, { force: true });
	}

	console.log(`Uploaded ${REQUIRED_SECRETS.length} required secrets and updated DDNS_ALLOWED_HOSTNAMES in wrangler.jsonc.`);
	return { apiToken, zoneId, sharedSecret, allowedHostnames };
}

async function main(): Promise<void> {
	await setupSecrets();
	await outro("Next: run `pnpm run deploy` or `pnpm run migrate:remote` if you attached a specific D1 database locally.");
}

if (isMainModule(import.meta.url)) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
}