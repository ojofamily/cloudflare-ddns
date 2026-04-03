import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	cancel as clackCancel,
	confirm as clackConfirm,
	intro as clackIntro,
	isCancel as clackIsCancel,
	log as clackLog,
	outro as clackOutro,
	text as clackText,
} from "@clack/prompts";
import { z } from "zod";

export const REQUIRED_SECRETS = [
	"CF_API_TOKEN",
	"CF_ZONE_ID",
	"DDNS_SHARED_SECRET",
] as const;

export const REQUIRED_VARS = ["DDNS_ALLOWED_HOSTNAMES"] as const;

const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const zoneIdSchema = z.string().regex(/^[0-9a-f]{32}$/i, "CF_ZONE_ID should be a 32-character hexadecimal zone ID.");
const nonEmptyTextSchema = z.string().trim().min(1, "This value cannot be empty.");
const sharedSecretSchema = z
	.string()
	.min(12, "Use a longer DDNS_SHARED_SECRET. At least 12 characters is recommended.");

type RequiredSecret = (typeof REQUIRED_SECRETS)[number];
type RequiredVar = (typeof REQUIRED_VARS)[number];

export interface WranglerD1Binding {
	binding: string;
	database_name: string;
	database_id?: string;
}

interface WranglerSecretsConfig {
	required?: string[];
}

export interface WranglerConfig {
	name: string;
	main?: string;
	d1_databases?: WranglerD1Binding[];
	secrets?: WranglerSecretsConfig;
	vars?: Record<string, string>;
	[key: string]: unknown;
}

interface WranglerResultOptions {
	input?: string;
	stdio?: "pipe" | "inherit";
}

interface PromptOptions {
	defaultValue?: string;
	placeholder?: string;
	validate?: (value: string) => string | undefined;
}

export interface HostnameValidationResult {
	ok: boolean;
	errors: string[];
	hostnames: string[];
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerConfigPath = path.join(projectRoot, "wrangler.jsonc");

function shouldUseClackUi(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function handleClackCancel(value: unknown): void {
	if (clackIsCancel(value)) {
		clackCancel("Operation cancelled.");
		process.exit(0);
	}
}

function stripJsonComments(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export async function readWranglerConfig(): Promise<WranglerConfig> {
	const raw = await fs.readFile(wranglerConfigPath, "utf8");
	return JSON.parse(stripJsonComments(raw)) as WranglerConfig;
}

export async function writeWranglerConfig(config: WranglerConfig): Promise<void> {
	await fs.writeFile(wranglerConfigPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

export function getPrimaryD1Binding(config: WranglerConfig): WranglerD1Binding | null {
	return config.d1_databases?.[0] ?? null;
}

export function isUuid(value: string): boolean {
	return uuidSchema.safeParse(value).success;
}

export function isZoneId(value: string): boolean {
	return zoneIdSchema.safeParse(value).success;
}

function isValidHostnameLabel(value: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);
}

export function validateAllowedHostnamesCsv(value: string): HostnameValidationResult {
	const errors: string[] = [];
	const normalized: string[] = [];
	const seen = new Set<string>();

	if (!value || !value.trim()) {
		return {
			ok: false,
			errors: ["DDNS_ALLOWED_HOSTNAMES cannot be empty."],
			hostnames: [],
		};
	}

	for (const [index, rawEntry] of value.split(",").entries()) {
		const entry = rawEntry.trim().toLowerCase();
		if (!entry) {
			errors.push(`Entry ${index + 1} is empty.`);
			continue;
		}

		const labels = entry.split(".");
		if (labels.length < 2) {
			errors.push(`Entry ${index + 1} must be a fully qualified hostname: ${entry}`);
			continue;
		}

		const wildcardLabels = labels.filter((label) => label === "*").length;
		if (wildcardLabels > 1) {
			errors.push(`Entry ${index + 1} can only contain one wildcard label: ${entry}`);
			continue;
		}

		if (wildcardLabels === 1 && labels[0] !== "*") {
			errors.push(`Entry ${index + 1} may only use a wildcard in the first label: ${entry}`);
			continue;
		}

		const invalidLabel = labels.find((label, labelIndex) => {
			if (label === "*" && labelIndex === 0) return false;
			return !isValidHostnameLabel(label);
		});

		if (invalidLabel) {
			errors.push(`Entry ${index + 1} contains an invalid label: ${entry}`);
			continue;
		}

		if (seen.has(entry)) {
			errors.push(`Entry ${index + 1} is duplicated: ${entry}`);
			continue;
		}

		seen.add(entry);
		normalized.push(entry);
	}

	return {
		ok: errors.length === 0,
		errors,
		hostnames: normalized,
	};
}

export function validateRequiredText(value: string, fieldName: string): string {
	const result = nonEmptyTextSchema.safeParse(value);
	if (result.success) {
		return "";
	}

	return `${fieldName} cannot be empty.`;
}

export function validateSharedSecret(value: string): string {
	const required = validateRequiredText(value, "DDNS_SHARED_SECRET");
	if (required) {
		return required;
	}

	const result = sharedSecretSchema.safeParse(value);
	return result.success ? "" : result.error.issues[0]?.message ?? "DDNS_SHARED_SECRET is invalid.";
}

export function validateZoneId(value: string): string {
	const required = validateRequiredText(value, "CF_ZONE_ID");
	if (required) {
		return required;
	}

	const result = zoneIdSchema.safeParse(value);
	return result.success ? "" : result.error.issues[0]?.message ?? "CF_ZONE_ID is invalid.";
}

export function generatedSharedSecret(): string {
	return randomBytes(24).toString("base64url");
}

export function wranglerBinaryPath(): string {
	return path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
}

export function runWrangler(args: string[], options: WranglerResultOptions = {}): string {
	const result = spawnSync(wranglerBinaryPath(), args, {
		cwd: projectRoot,
		encoding: "utf8",
		input: options.input,
		stdio: options.stdio ?? "pipe",
	});

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(details || `Wrangler command failed: ${args.join(" ")}`);
	}

	return (result.stdout ?? "").trim();
}

export function ensureWranglerAuth(): void {
	try {
		runWrangler(["whoami"]);
	} catch {
		throw new Error("Wrangler is not logged in. Run `npx wrangler login` and try again.");
	}
}

export async function prompt(question: string, options: PromptOptions = {}): Promise<string> {
	if (shouldUseClackUi()) {
		const answer = await clackText({
			message: question,
			initialValue: options.defaultValue,
			placeholder: options.placeholder,
			validate: options.validate
				? (value) => options.validate?.(value ?? "")
				: undefined,
		});

		handleClackCancel(answer);

		return String(answer).trim();
	}

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const suffix = options.defaultValue ? ` [${options.defaultValue}]` : "";
		const answer = (await rl.question(`${question}${suffix}: `)).trim();
		if (!answer && options.defaultValue !== undefined) {
			return options.defaultValue;
		}
		return answer;
	} finally {
		rl.close();
	}
}

export async function promptYesNo(question: string, defaultValue = true): Promise<boolean> {
	if (shouldUseClackUi()) {
		const answer = await clackConfirm({
			message: question,
			initialValue: defaultValue,
		});

		handleClackCancel(answer);

		return Boolean(answer);
	}

	const hint = defaultValue ? "Y/n" : "y/N";
	const answer = (await prompt(`${question} (${hint})`)).toLowerCase();
	if (!answer) return defaultValue;
	return answer === "y" || answer === "yes";
}

export function isMainModule(metaUrl: string): boolean {
	const target = process.argv[1];
	if (!target) return false;
	return metaUrl === pathToFileURL(path.resolve(target)).href;
}

export function printHeading(title: string): void {
	console.log(`\n== ${title} ==`);
}

export async function intro(title: string): Promise<void> {
	if (shouldUseClackUi()) {
		clackIntro(title);
		return;
	}

	printHeading(title);
}

export async function outro(message: string): Promise<void> {
	if (shouldUseClackUi()) {
		clackOutro(message);
		return;
	}

	console.log(message);
}

export async function step(message: string): Promise<void> {
	if (shouldUseClackUi()) {
		clackLog.step(message);
		return;
	}

	printHeading(message);
}

export async function success(message: string): Promise<void> {
	if (shouldUseClackUi()) {
		clackLog.success(message);
		return;
	}

	console.log(message);
}

export async function info(message: string): Promise<void> {
	if (shouldUseClackUi()) {
		clackLog.info(message);
		return;
	}

	console.log(message);
}

export function getRequiredVar(config: WranglerConfig, name: RequiredVar): string {
	return config.vars?.[name]?.trim() ?? "";
}
