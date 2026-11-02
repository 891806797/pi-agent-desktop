/**
 * backend 入口 —— Bun.serve + Elysia app + 编译版前端静态服务 + janitor。
 */

import type { DesktopReady } from "@pi-agent/common";
import { createApp } from "@/core/create-app";
import { env } from "@/env";
import { registry } from "@/modules/agent/session-registry";
import { getJwtSecret } from "@/modules/auth/token";
import { ensureSeed, listAuthUsers } from "@/modules/auth/users";
import {
	acceptsDesktopRequest,
	appVersion,
	installHostShutdown,
} from "@/modules/system/desktop-host";
import { routes } from "@/routes";

try {
	if (env.desktopToken === "") throw new Error("empty desktop token");
	getJwtSecret();
	ensureSeed();

	const app = createApp().use(routes);
	registry.startJanitor();

	const server = Bun.serve({
		port: env.port,
		hostname: env.host,
		// SSE 长连接：审批等待期间无数据，默认 10s idleTimeout 会过早关连接，提到 240s
		idleTimeout: 240,
		fetch: (request) =>
			acceptsDesktopRequest(request)
				? app.handle(request)
				: Response.json({ ok: false, code: "FORBIDDEN", message: "连接凭据无效" }, { status: 403 }),
	});

	installHostShutdown(
		() => registry.stop({ preserveRunning: true }),
		() => server.stop(true),
	);
	if (env.desktopToken !== undefined) {
		console.log(
			JSON.stringify({
				type: "ready",
				protocol: 1,
				url: server.url.toString(),
				version: appVersion,
			} satisfies DesktopReady),
		);
	} else console.log(`[pi-agent] listening on ${server.url}`);
	void registry.recoverPersisted(listAuthUsers()).catch(console.error);
} catch {
	console.error("[pi-agent] startup failed");
	process.exit(1);
}
