import type { D1Migration } from "cloudflare:test";
import type { DdnsEnv } from "../src/types";

export type Env = DdnsEnv & {
	MIGRATIONS: D1Migration[];
};

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
