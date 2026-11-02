import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ApprovalManager } from "../../src/modules/agent/approval-manager";
import { SessionEventBus } from "../../src/modules/agent/event-bus";
import { SessionUI } from "../../src/modules/agent/session-ui";

/** 真实 UI 桥接的隔离浏览器夹具，不向生产服务增加调试接口。 */
export function extensionBrowserHarness() {
	const bus = new SessionEventBus();
	const approvals = new ApprovalManager(bus);
	const ui = new SessionUI(bus, approvals);
	const results: unknown[] = [];
	let bundle: Promise<string> | undefined;
	return {
		dispose() {
			approvals.rejectAll("test finished");
			ui.dispose();
		},
		async handle(request: Request): Promise<Response | undefined> {
			const url = new URL(request.url);
			if (url.pathname === "/extension-test")
				return new Response(
					'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="/extension-style"></head><body><div id="root"></div><script type="module" src="/extension-script"></script></body></html>',
					{ headers: { "content-type": "text/html; charset=utf-8" } },
				);
			if (url.pathname === "/extension-script") {
				bundle ??= Bun.build({
					entrypoints: [resolve(import.meta.dir, "../../../frontend/test/probes/extensions.tsx")],
					target: "browser",
				}).then(async (result) => {
					if (!result.success) throw new Error(result.logs.map(String).join("\n"));
					return result.outputs[0]!.text();
				});
				return new Response(await bundle, { headers: { "content-type": "text/javascript" } });
			}
			if (url.pathname === "/extension-style") {
				const dir = resolve(import.meta.dir, "../../../frontend/dist/assets");
				return new Response(
					Bun.file(resolve(dir, readdirSync(dir).find((name) => name.endsWith(".css"))!)),
					{ headers: { "content-type": "text/css" } },
				);
			}
			if (url.pathname === "/extension-state")
				return Response.json({
					ui: ui.snapshot,
					pending: approvals.pendingList(),
					seq: bus.currentSeq,
					results,
				});
			if (url.pathname === "/extension-exercise") {
				ui.setStatus("build", "第一行\n第二行");
				ui.setWidget("上方说明", ["one", "two"], "aboveEditor");
				ui.setWidget("下方说明", ["below"], "belowEditor");
				ui.flush();
				void ui
					.withSource(crypto.randomUUID(), () => ui.editor("扩展编辑验收", "原始\n内容"))
					.then((value) => results.push(value ?? null));
				return Response.json({ ok: true });
			}
			if (url.pathname === "/extension-answer") {
				const input = (await request.json()) as {
					id: string;
					action: "answer" | "cancel";
					data: unknown;
				};
				return Response.json({
					settled: approvals.settle(
						input.id,
						input.action === "cancel"
							? { action: "cancelled" }
							: { action: "answer", data: input.data },
					),
				});
			}
			if (url.pathname === "/extension-events") {
				let stop = () => {};
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(": connected\n\n"));
							const send = (event: ReturnType<SessionEventBus["publish"]>) =>
								controller.enqueue(
									new TextEncoder().encode(
										`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`,
									),
								);
							for (const event of bus.replaySince(Number(url.searchParams.get("sinceSeq"))) ?? [])
								send(event);
							stop = bus.subscribe(send);
							request.signal.addEventListener(
								"abort",
								() => {
									stop();
									try {
										controller.close();
									} catch {}
								},
								{ once: true },
							);
						},
						cancel() {
							stop();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
		},
	};
}
