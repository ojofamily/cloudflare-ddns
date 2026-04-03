import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { Env } from "./bindings";

// Setup files run outside isolated storage, and may be run multiple times.
// `applyD1Migrations()` only applies migrations that haven't already been
// applied, therefore it is safe to call this function here.
const testEnv = env as Env;

await applyD1Migrations(testEnv.DB, testEnv.MIGRATIONS);
