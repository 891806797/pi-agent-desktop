import { Elysia } from "elysia";
import { serveFrontend } from "@/modules/system/frontend";
import { agentRoutes } from "./agent.route";
import { authRoutes } from "./auth.route";
import { sseRoutes } from "./sse.route";
import { systemRoutes } from "./system.route";

export const routes = new Elysia()
	.use(authRoutes)
	.use(systemRoutes)
	.use(agentRoutes)
	.use(sseRoutes)
	.get("*", async ({ request }) => {
		const path = new URL(request.url).pathname;
		if (!path.startsWith("/api/")) {
			const frontend = await serveFrontend(path);
			if (frontend) return frontend;
		}
		return Response.json({ ok: false, code: "NOT_FOUND", message: "资源不存在" }, { status: 404 });
	});
