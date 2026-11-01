/**
 * backend 入口 —— Bun.serve + Elysia app + 编译版前端静态服务 + janitor。
 */

import { createApp } from "@/core/create-app";
import { env } from "@/env";
import { registry } from "@/modules/agent/session-registry";
import { ensureSeed, listAuthUsers } from "@/modules/auth/users";
import { routes } from "@/routes";

ensureSeed();

const app = createApp().use(routes);
registry.startJanitor();

const server = Bun.serve({
	port: env.port,
	hostname: env.host,
	// SSE 长连接：审批等待期间无数据，默认 10s idleTimeout 会过早关连接，提到 240s
	idleTimeout: 240,
	fetch: (request) => app.handle(request),
});

console.log(`[pi-agent] listening on ${server.url}`);
void registry.recoverPersisted(listAuthUsers()).catch(console.error);

async function shutdown(): Promise<void> {
	await registry.stop({ preserveRunning: true });
	server.stop(true);
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
