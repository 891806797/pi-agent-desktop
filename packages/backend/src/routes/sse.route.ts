/**
 * SSE 路由 —— 会话事件流（EventSource）。
 *
 * 坐标走 query（EventSource 无法设自定义 header）：sessionId 路径 + workspace query，
 * JWT 靠 httpOnly cookie 自动携带，token 绝不进 query（§5.10）。
 * 断线重连：浏览器自动带 Last-Event-ID（或 ?sinceSeq=）→ 总线 replaySince 增量重放；
 * 环形缓冲跳洞 → 发 RESYNC_MESSAGE 后断流，前端拉 history 全量对账再重连。
 */

import type { SSEEvent } from "@pi-agent/common";
import { RESYNC_MESSAGE } from "@pi-agent/common";
import { Elysia } from "elysia";
import { AppError } from "@/core/app-error";
import { env } from "@/env";
import { requireCtx } from "@/modules/agent/agent.service";
import { registry } from "@/modules/agent/session-registry";
import { requireUser } from "@/modules/auth/auth.service";
import { authContext } from "./auth.middleware";

export const sseRoutes = new Elysia()
	.use(authContext)
	.get("/api/sessions/:sessionId/events", ({ params, query, headers, request, user }) => {
		const u = requireUser(user);
		const ctx = requireCtx(u, params.sessionId, String(query.workspace ?? ""));

		const lastSeqRaw = headers["last-event-id"] ?? query.sinceSeq;
		const lastSeq = Number(lastSeqRaw) || 0;
		if (!Number.isSafeInteger(lastSeq) || lastSeq < 0)
			throw new AppError("BAD_REQUEST", "事件游标不合法");
		const encoder = new TextEncoder();
		const sessionCtx = ctx; // 闭包捕获（TS 收窄）
		const wrongEpoch = query.epoch !== undefined && query.epoch !== ctx.bus.epoch;

		let cancelStream: () => void = () => {};
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;
				// 声明先于 cleanup：resync 早退路径在订阅建立前就会调用 cleanup
				let heartbeat: ReturnType<typeof setInterval> | undefined;
				let unsubscribe: () => void = () => {};
				const write = (chunk: string): void => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(chunk));
					} catch {
						cleanup();
					}
				};
				const send = (name: string, data: unknown, id?: number): void => {
					write(
						`${id !== undefined ? `id: ${id}\n` : ""}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
					);
				};
				const cleanup = (): void => {
					if (closed) return;
					closed = true;
					if (heartbeat) clearInterval(heartbeat);
					unsubscribe();
					request.signal.removeEventListener("abort", cleanup);
					try {
						controller.close();
					} catch {
						// 已关则忽略
					}
				};
				cancelStream = cleanup;
				if (wrongEpoch) {
					send("error", { message: RESYNC_MESSAGE });
					cleanup();
					return;
				}

				// 1) 增量重放（Last-Event-ID / sinceSeq）
				if (lastSeq > 0) {
					const replay = sessionCtx.bus.replaySince(lastSeq);
					if (replay === undefined) {
						// 跳洞：通知前端全量对账后重连
						send("error", { message: RESYNC_MESSAGE });
						cleanup();
						return;
					}
					for (const ev of replay) send(ev.event, ev.data, ev.seq);
				}
				// 2) 挂起审批重放（不带 seq，前端按 requestId 幂等）
				for (const pending of sessionCtx.approvals.pendingList()) {
					send("approval_request", pending);
				}
				// 3) 订阅总线（所有 tab 同一定序源）
				unsubscribe = sessionCtx.bus.subscribe((ev: SSEEvent & { seq: number }) => {
					send(ev.event, ev.data, ev.seq);
					if (ev.event === "query_closed") cleanup();
				});
				heartbeat = setInterval(
					() => send("heartbeat", { seq: sessionCtx.bus.currentSeq }),
					env.sseHeartbeatSec * 1000,
				);

				request.signal.addEventListener("abort", cleanup, { once: true });
				if (request.signal.aborted) cleanup();
			},
			cancel() {
				cancelStream();
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	})
	.get("/api/user/events", ({ query, headers, request, user }) => {
		const u = requireUser(user);
		const hub = registry.catalog().hub(u.userId);
		const since = Number(headers["last-event-id"] ?? query.sinceSeq ?? 0);
		if (!Number.isSafeInteger(since) || since < 0)
			throw new AppError("BAD_REQUEST", "事件游标不合法");
		let cleanup = () => {};
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;
				let unsubscribe = () => {};
				let timer: ReturnType<typeof setInterval> | undefined;
				cleanup = () => {
					if (closed) return;
					closed = true;
					if (timer) clearInterval(timer);
					unsubscribe();
					request.signal.removeEventListener("abort", cleanup);
					try {
						controller.close();
					} catch {}
				};
				const send = (event: string, data: unknown, seq?: number) => {
					if (closed) return;
					try {
						controller.enqueue(
							new TextEncoder().encode(
								`${seq !== undefined ? `id: ${seq}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
							),
						);
					} catch {
						cleanup();
					}
				};
				const replay = hub.replay(String(query.epoch ?? ""), since);
				if (!replay) {
					send("resync", {});
					cleanup();
					return;
				}
				for (const item of replay) send(item.event, item, item.seq);
				unsubscribe = hub.subscribe((item) => send(item.event, item, item.seq));
				timer = setInterval(() => send("heartbeat", hub.cursor), env.sseHeartbeatSec * 1000);
				request.signal.addEventListener("abort", cleanup, { once: true });
				if (request.signal.aborted) cleanup();
			},
			cancel() {
				cleanup();
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	});
