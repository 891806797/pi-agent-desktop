import { timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { env } from "@/env";
import rootPackage from "../../../../../package.json";
import { desktopShellHost } from "./desktop-shell";

declare const APP_VERSION: string;
export const appVersion = typeof APP_VERSION === "string" ? APP_VERSION : rootPackage.version;

/** 在 fetch 边界检查，覆盖健康检查、登录、SSE、静态资源与未匹配路由。 */
export function acceptsDesktopRequest(request: Request): boolean {
	if (env.desktopToken === undefined) return true;
	const received = request.headers.get("x-pi-desktop-token");
	if (!received || !env.desktopToken) return false;
	const actual = Buffer.from(received);
	const expected = Buffer.from(env.desktopToken);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 所有退出入口共用同一 Promise；外层宿主负责最终回收受管进程树。 */
export function installHostShutdown(stop: () => Promise<void>, stopServer: () => void) {
	let work: Promise<void> | undefined;
	const shutdown = () => {
		work ??= (async () => {
			const deadline = setTimeout(() => {
				console.error("[pi-agent] shutdown timed out");
				void desktopShellHost?.stop();
				stopServer();
				process.exit(1);
			}, 5000);
			let exitCode = 0;
			try {
				// 先拒绝新请求并断开 SSE，再等待已持久化的会话释放资源。
				stopServer();
				await stop();
			} catch {
				console.error("[pi-agent] shutdown failed");
				exitCode = 1;
			} finally {
				await desktopShellHost?.stop();
				clearTimeout(deadline);
				process.exit(exitCode);
			}
		})();
		return work;
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	if (env.desktopToken !== undefined) {
		const control = createInterface({ input: process.stdin });
		control.on("line", (line) => {
			try {
				if (JSON.parse(line)?.type === "shutdown") void shutdown();
			} catch {
				console.error("[pi-agent] invalid desktop control frame");
			}
		});
		control.on("close", () => void shutdown());
		process.stdin.on("error", () => void shutdown());
	}
	return shutdown;
}
