import { contentJson, OpenAPIRoute } from "chanfana";
import { z } from "zod";

export class HealthEndpoint extends OpenAPIRoute {
	schema = {
		tags: ["System"],
		summary: "Health check",
		responses: {
			"200": {
				description: "Service is healthy",
				...contentJson(z.object({ ok: z.literal(true) })),
			},
		},
	};

	async handle() {
		return { ok: true as const };
	}
}
