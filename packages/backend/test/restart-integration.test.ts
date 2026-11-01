import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ApiResult, HistoryResponse } from "@pi-agent/common";
import { RuntimeStore } from "../src/modules/agent/runtime-store";
import { waitForServer } from "./probes/server-startup";

test("real SDK restores pending permission and question after a hard process restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-restart-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	writeFileSync(join(workspace, "edited.txt"), "old");
	let heldModelRequests = 0;
	let queuedImageReceived = false;
	let questionTimeoutDefault = false;
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = (await request.json()) as {
				messages: Array<{ role: string; content: unknown }>;
			};
			const userIndex = body.messages.findLastIndex((message) => message.role === "user");
			questionTimeoutDefault ||= body.messages.some(
				(message) =>
					message.role === "tool" && JSON.stringify(message.content).includes("请自主决策"),
			);
			const text = JSON.stringify(body.messages[userIndex]?.content);
			if (text.includes("restart-model") && ++heldModelRequests === 1)
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "content-type": "text/event-stream" },
				});
			if (text.includes("queued-image"))
				queuedImageReceived = JSON.stringify(body.messages[userIndex]?.content).includes(
					"image_url",
				);
			const afterTool = body.messages
				.slice(userIndex + 1)
				.some((message) => message.role === "tool");
			const tool =
				!afterTool && text.includes("permission")
					? {
							name: "write",
							arguments: JSON.stringify({
								path: text.includes("timeout") ? "timeout.txt" : "restored.txt",
								content: "one write",
							}),
						}
					: !afterTool && text.includes("question")
						? {
								name: "ask_user_question",
								arguments: JSON.stringify({
									questions: [
										{ question: "恢复后的选择", options: [{ label: "继续" }], allowCustom: false },
									],
								}),
							}
						: !afterTool && text.includes("legacy-edit")
							? {
									name: "edit",
									arguments: JSON.stringify({ path: "edited.txt", oldText: "old", newText: "new" }),
								}
							: undefined;
			const delta = tool
				? {
						role: "assistant",
						tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: tool }],
					}
				: { role: "assistant", content: "恢复后完成" };
			return new Response(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let base = "";
	let cookie = "";
	const encoded = Buffer.from(workspace).toString("base64url");
	const launch = async () => {
		child = Bun.spawn([process.execPath, "--no-env-file", "run", "src/index.ts"], {
			cwd: resolve(import.meta.dir, ".."),
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				TEMP: tmpdir(),
				TMP: tmpdir(),
				USERPROFILE: process.env.USERPROFILE,
				PI_OFFLINE: "1",
				HOST: "127.0.0.1",
				PORT: "0",
				DATA_DIR: join(root, "data"),
				WORKSPACE_ROOTS: workspace,
				JWT_SECRET: "restart-test",
				SSE_HEARTBEAT_SEC: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		base = await waitForServer(child.stdout as ReadableStream<Uint8Array>);
	};
	const call = async (path: string, method = "GET", body?: unknown, sid?: string) =>
		fetch(`${base}/api/${path}`, {
			method,
			headers: {
				cookie,
				"content-type": "application/json",
				...(sid ? { "x-session-id": sid, "x-workspace-dir": encoded } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const poll = async (sid: string, predicate: (data: HistoryResponse) => boolean) => {
		for (let i = 0; i < 120; i++) {
			const response = await call("session/messages", "GET", undefined, sid);
			const result = (await response.json()) as ApiResult<HistoryResponse>;
			if (result.ok && predicate(result.data)) return result.data;
			await Bun.sleep(25);
		}
		throw new Error("restart recovery did not become ready");
	};
	const restart = async () => {
		child!.kill("SIGKILL");
		await child!.exited;
		await launch();
	};
	try {
		await launch();
		const login = await call("auth/login", "POST", { username: "admin", password: "admin123" });
		cookie = login.headers.get("set-cookie")!.split(";")[0]!;
		expect(
			(
				await call("settings/models", "PUT", {
					providers: {
						fixture: {
							api: "openai-completions",
							apiKey: "test",
							baseUrl: `http://127.0.0.1:${provider.port}/v1`,
							models: [
								{ id: "fixture", input: ["text", "image"], contextWindow: 32768, maxTokens: 1024 },
							],
						},
					},
				})
			).ok,
		).toBe(true);
		const created = (await (await call("sessions", "POST", { workspace: encoded })).json()) as {
			data: { sessionId: string };
		};
		const sid = created.data.sessionId;
		expect(
			(await call("session/model", "PUT", { provider: "fixture", modelId: "fixture" }, sid)).ok,
		).toBe(true);
		await call("session/run-mode", "PUT", { mode: "safe" }, sid);
		for (const label of ["permission", "question", "legacy-edit"]) {
			expect((await call("session/messages", "POST", { text: label }, sid)).ok).toBe(true);
			const waiting = await poll(sid, (data) => data.pendingApprovals.length === 1);
			const request = waiting.pendingApprovals[0];
			await restart();
			const restored = await poll(sid, (data) => data.pendingApprovals.length === 1);
			expect(restored.pendingApprovals[0]).toEqual(request);
			const action =
				label !== "question"
					? { action: "allow" }
					: { action: "answer", data: { answers: { 恢复后的选择: "继续" } } };
			expect((await call(`session/approvals/${request.requestId}`, "POST", action, sid)).ok).toBe(
				true,
			);
			await poll(sid, (data) => data.status === "idle" && data.pendingApprovals.length === 0);
		}
		expect(readFileSync(join(workspace, "restored.txt"), "utf8")).toBe("one write");
		expect(readFileSync(join(workspace, "edited.txt"), "utf8")).toBe("new");
		for (const mode of ["safe", "auto", "question"] as const) {
			await call("session/run-mode", "PUT", { mode: "safe" }, sid);
			await call(
				"session/messages",
				"POST",
				{ text: `${mode === "question" ? "question" : "permission"}-timeout-${mode}` },
				sid,
			);
			await poll(sid, (data) => data.pendingApprovals.length === 1);
			await call("session/run-mode", "PUT", { mode: mode === "question" ? "safe" : mode }, sid);
			child!.kill("SIGKILL");
			await child!.exited;
			const store = new RuntimeStore(join(root, "data/runtime.sqlite"));
			try {
				const owner = store.list().find((row) => row.sessionId === sid)!;
				const state = store.read(owner.userId, sid)!;
				for (const approval of state.approvals.filter((entry) => !entry.outcome)) {
					approval.request.createdAt = Date.now() - 301000;
					approval.request.expiresAt = Date.now() - 1000;
				}
				store.write(state);
			} finally {
				store.close();
			}
			await launch();
			await poll(sid, (data) => data.status === "idle" && data.pendingApprovals.length === 0);
			if (mode === "auto")
				expect(readFileSync(join(workspace, "timeout.txt"), "utf8")).toBe("one write");
			else if (mode === "safe")
				expect(await Bun.file(join(workspace, "timeout.txt")).exists()).toBe(false);
			else expect(questionTimeoutDefault).toBe(true);
		}
		expect((await call("session/messages", "POST", { text: "restart-model" }, sid)).ok).toBe(true);
		for (let i = 0; i < 100 && !heldModelRequests; i++) await Bun.sleep(10);
		expect(heldModelRequests).toBe(1);
		expect(
			(
				await call(
					"session/messages",
					"POST",
					{
						text: "queued-image",
						images: [
							{
								type: "image",
								mimeType: "image/png",
								data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
							},
						],
					},
					sid,
				)
			).ok,
		).toBe(true);
		const queued = await poll(sid, (data) => data.queue.followUp.includes("queued-image"));
		expect(queued.queue.followUp).toEqual(["queued-image"]);
		await restart();
		const completed = await poll(sid, (data) => data.status === "idle" && queuedImageReceived);
		expect(completed.queue.followUp).toEqual([]);
		expect(
			completed.messages.filter(
				(message) => message.type === "user" && JSON.stringify(message).includes("queued-image"),
			),
		).toHaveLength(1);
	} finally {
		child?.kill();
		await child?.exited;
		provider.stop(true);
	}
}, 30000);
