import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../../src/index";
import type { Env } from "../bindings";
import { dropLogSchema } from "../helpers";

function createExecutionContext(): {
	ctx: ExecutionContext;
	waitForTasks: () => Promise<void>;
} {
	const tasks: Promise<unknown>[] = [];

	return {
		ctx: {
			waitUntil(task: Promise<unknown>) {
				tasks.push(task);
			},
			passThroughOnException() {
				return;
			},
		} as ExecutionContext,
		waitForTasks: async () => {
			await Promise.all(tasks);
		},
	};
}

describe("scheduled cleanup", () => {
	it("does nothing when cleanup runs before migrations", async () => {
		await dropLogSchema(env.DB);

		const { ctx, waitForTasks } = createExecutionContext();
		await worker.scheduled({} as ScheduledEvent, env as Env, ctx);
		await waitForTasks();

		const { results } = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ddns_logs'",
		).all();

		expect(results).toHaveLength(0);
	});
});