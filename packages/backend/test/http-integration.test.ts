import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForServer } from "./probes/server-startup";

test("隔离 HTTP/SDK：三页面审批/提问同步、运行中配置切换在下一请求生效", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-web-http-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const dataDir = join(root, "data");
	const providerRequests: Array<{
		model: string;
		reasoning_effort?: string;
		messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>;
	}> = [];
	let releaseFirst!: () => void;
	const firstRequestGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let releaseQueuedRun!: () => void;
	let releaseSelectedRun!: () => void;
	const queuedRunGate = new Promise<void>((resolve) => {
		releaseQueuedRun = resolve;
	});
	const selectedRunGate = new Promise<void>((resolve) => {
		releaseSelectedRun = resolve;
	});
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = (await request.json()) as (typeof providerRequests)[number];
			providerRequests.push(body);
			if (providerRequests.length === 1) await firstRequestGate;
			if (providerRequests.length === 4) await queuedRunGate;
			if (providerRequests.length === 5) await selectedRunGate;
			const afterWrite = body.messages.some(
				(message) => message.role === "tool" && message.tool_call_id === "call_write",
			);
			const afterAsk = body.messages.some(
				(message) => message.role === "tool" && message.tool_call_id === "call_ask",
			);
			const parts = afterAsk
				? [{ role: "assistant", content: "工具执行完成" }]
				: afterWrite
					? [
							{
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "call_ask",
										type: "function",
										function: {
											name: "ask_user_question",
											arguments: JSON.stringify({
												questions: [
													{
														question: "是否继续？",
														options: [{ label: "继续" }],
														allowCustom: false,
													},
												],
											}),
										},
									},
								],
							},
						]
					: [
							{
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: "call_write",
										type: "function",
										function: {
											name: "write",
											arguments: JSON.stringify({ path: "probe.txt", content: "review fixture" }),
										},
									},
								],
							},
						];
			const stream = new ReadableStream({
				async start(controller) {
					for (const delta of parts) {
						await Bun.sleep(20);
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
							),
						);
					}
					controller.enqueue(
						new TextEncoder().encode(
							`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: afterAsk ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, prompt_tokens_details: { cached_tokens: 60 } } })}\n\ndata: [DONE]\n\n`,
						),
					);
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const child = Bun.spawn([process.execPath, "--no-env-file", "run", "src/index.ts"], {
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
			DATA_DIR: dataDir,
			WORKSPACE_ROOTS: workspace,
			JWT_SECRET: "isolated-development-test",
			SSE_HEARTBEAT_SEC: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const aborters: AbortController[] = [];
	try {
		const base = await waitForServer(child.stdout);
		expect((await fetch(`${base}/api/health`)).ok).toBe(true);
		const login = await fetch(`${base}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "admin", password: "admin123" }),
		});
		expect(login.status).toBe(200);
		const cookie = login.headers.get("set-cookie")!.split(";")[0];
		const invalidSettings = await fetch(`${base}/api/settings/models`, {
			method: "PUT",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ providers: { fixture: { models: [{ id: 123 }] } } }),
		});
		expect(invalidSettings.status).toBe(400);
		const users = JSON.parse(readFileSync(join(dataDir, "users.json"), "utf8")) as Array<{
			id: string;
		}>;
		const agentDir = join(dataDir, "users", users[0].id, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						api: "openai-completions",
						apiKey: "development-fixture",
						baseUrl: `http://127.0.0.1:${provider.port}/v1`,
						models: [
							{ id: "fixture", reasoning: false, contextWindow: 32768, maxTokens: 1024 },
							{ id: "fixture-reasoning", reasoning: true, contextWindow: 32768, maxTokens: 1024 },
						],
					},
				},
			}),
		);
		const encoded = Buffer.from(workspace).toString("base64url");
		const create = await fetch(`${base}/api/sessions`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({ workspace: encoded }),
		});
		const created = (await create.json()) as {
			ok: boolean;
			data: { sessionId: string };
			message?: string;
		};
		if (!created.ok) throw new Error(created.message);
		const sid = created.data.sessionId;
		const headers = {
			cookie,
			"content-type": "application/json",
			"x-session-id": sid,
			"x-workspace-dir": encoded,
		};
		const call = async (path: string, method = "GET", body?: unknown) =>
			fetch(`${base}/api/session/${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		expect((await call("model", "PUT", { provider: "fixture", modelId: "fixture" })).status).toBe(
			200,
		);
		expect((await call("run-mode", "PUT", { mode: "auto" })).status).toBe(200);
		const history = (await (await call("messages")).json()) as {
			data: { seq: number; sessionId: string };
		};
		expect(history.data.sessionId).toBe(sid);
		type Event = { seq: number; event: string; data: Record<string, unknown> };
		const pages: Event[][] = [[], [], []];
		for (const page of pages) {
			const aborter = new AbortController();
			aborters.push(aborter);
			const response = await fetch(
				`${base}/api/sessions/${sid}/events?workspace=${encoded}&sinceSeq=${history.data.seq}`,
				{ headers: { cookie }, signal: aborter.signal },
			);
			void (async () => {
				let buffer = "";
				const decoder = new TextDecoder();
				try {
					for await (const chunk of response.body!) {
						buffer += decoder.decode(chunk, { stream: true });
						let end = buffer.indexOf("\n\n");
						while (end >= 0) {
							const frame = buffer.slice(0, end);
							buffer = buffer.slice(end + 2);
							const event = /^event: (.+)$/m.exec(frame)?.[1];
							const data = /^data: (.+)$/m.exec(frame)?.[1];
							if (event && data)
								page.push({
									event,
									seq: Number(/^id: (\d+)$/m.exec(frame)?.[1] ?? 0),
									data: JSON.parse(data),
								});
							end = buffer.indexOf("\n\n");
						}
					}
				} catch {
					/* 主动断开 */
				}
			})();
		}
		const waitFor = async (predicate: () => boolean) => {
			for (let n = 0; n < 200 && !predicate(); n++) await Bun.sleep(20);
			if (!predicate()) throw new Error(`事件等待超时：${JSON.stringify(pages[0])}`);
		};
		const sent = await call("messages", "POST", { text: "请写入测试文件" });
		expect(sent.status).toBe(200);
		await waitFor(() => providerRequests.length === 1);
		expect(providerRequests[0].model).toBe("fixture");
		// 第一请求已在 Provider 内等待：改设置不能重启它，但下一请求必须读新值。
		expect(
			(await call("model", "PUT", { provider: "fixture", modelId: "fixture-reasoning" })).status,
		).toBe(200);
		expect((await call("thinking", "PUT", { level: "high" })).status).toBe(200);
		expect((await call("run-mode", "PUT", { mode: "safe" })).status).toBe(200);
		await waitFor(() =>
			pages.every((page) =>
				page.some(
					(event) => event.event === "thinking_level_changed" && event.data.level === "high",
				),
			),
		);
		expect(providerRequests).toHaveLength(1);
		releaseFirst();
		await waitFor(() =>
			pages.every((page) => page.some((event) => event.event === "approval_request")),
		);
		const requestId = pages[0].find((event) => event.event === "approval_request")!.data.requestId;
		const permissionRace = await Promise.all([
			call(`approvals/${requestId}`, "POST", { action: "allow" }),
			call(`approvals/${requestId}`, "POST", { action: "allow" }),
		]);
		expect(permissionRace.map((response) => response.status).sort()).toEqual([200, 404]);
		await waitFor(() =>
			pages.every((page) => page.some((event) => event.event === "approval_settled")),
		);
		await waitFor(() =>
			pages.every((page) =>
				page.some(
					(event) => event.event === "approval_request" && event.data.kind === "ask_question",
				),
			),
		);
		expect(providerRequests[1].model).toBe("fixture-reasoning");
		expect(providerRequests[1].reasoning_effort).toBe("high");
		const ask = pages[0].find(
			(event) => event.event === "approval_request" && event.data.kind === "ask_question",
		)!;
		const waiting = (
			(await (await call("messages")).json()) as {
				data: { status: string; pendingApprovals: Array<{ requestId: string }> };
			}
		).data;
		expect(waiting.status).toBe("awaiting-approval");
		expect(waiting.pendingApprovals.map((item: { requestId: string }) => item.requestId)).toEqual([
			String(ask.data.requestId),
		]);
		expect(
			(
				await call(`approvals/${ask.data.requestId}`, "POST", {
					action: "answer",
					data: { answers: {} },
				})
			).status,
		).toBe(400);
		const answerRace = await Promise.all([
			call(`approvals/${ask.data.requestId}`, "POST", {
				action: "answer",
				data: { answers: { "是否继续？": "继续" } },
			}),
			call(`approvals/${ask.data.requestId}`, "POST", {
				action: "answer",
				data: { answers: { "是否继续？": "继续" } },
			}),
		]);
		expect(answerRace.map((response) => response.status).sort()).toEqual([200, 404]);
		await waitFor(() =>
			pages.every((page) =>
				page.some(
					(event) =>
						event.event === "approval_settled" && event.data.requestId === ask.data.requestId,
				),
			),
		);
		await waitFor(() =>
			pages.every((page) =>
				page.some((event) => event.event === "status" && event.data.status === "idle"),
			),
		);
		expect(readFileSync(join(workspace, "probe.txt"), "utf8")).toBe("review fixture");
		expect(providerRequests).toHaveLength(3);
		await waitFor(() =>
			pages.every((page) =>
				page.some((event) => event.event === "session_metrics" && event.data.outputTokens === 75),
			),
		);
		for (const page of pages) {
			expect(page.findLast((event) => event.event === "session_metrics")?.data).toMatchObject({
				inputTokens: 120,
				outputTokens: 75,
				cacheReadTokens: 180,
				cacheHitRate: 60,
			});
		}
		const snapshotMetrics = (
			(await (await call("messages")).json()) as { data: { metrics: unknown } }
		).data.metrics;
		expect(snapshotMetrics).toEqual(
			pages[0].findLast((event) => event.event === "session_metrics")?.data,
		);
		expect(
			providerRequests[2].messages.some(
				(message) => message.role === "tool" && String(message.content).includes("继续"),
			),
		).toBe(true);
		expect(pages[0].filter((event) => event.seq > 0)).toEqual(
			pages[1].filter((event) => event.seq > 0),
		);
		expect(pages[1].filter((event) => event.seq > 0)).toEqual(
			pages[2].filter((event) => event.seq > 0),
		);
		const settled = (await (await call("messages")).json()) as {
			data: { pendingApprovals: unknown[]; messages: Array<{ id: string }> };
		};
		expect(settled.data.pendingApprovals).toEqual([]);
		expect(settled.data.messages.length).toBeGreaterThanOrEqual(3);
		for (const event of pages[0].filter((event) => event.event === "user_message")) {
			expect(settled.data.messages.some((message) => message.id === event.data.uuid)).toBe(true);
		}
		// 真实 SDK 正在请求时，两页同时选择“停止后发送”：只能发送一次，保留另一条队列输入。
		expect((await call("messages", "POST", { text: "等待队列验证" })).status).toBe(200);
		await waitFor(() => providerRequests.length === 4);
		expect((await call("messages", "POST", { text: "选中立即发送" })).status).toBe(200);
		expect((await call("messages", "POST", { text: "保留继续排队" })).status).toBe(200);
		const queued = (
			(await (await call("messages")).json()) as {
				data: { queue: { followUp: string[]; revision: number } };
			}
		).data.queue;
		expect(queued.followUp).toEqual(["选中立即发送", "保留继续排队"]);
		expect(
			(
				await call("queue/dispatch", "POST", {
					requestId: crypto.randomUUID(),
					index: 0,
					behavior: "followUp",
					expectedText: "选中立即发送",
					revision: queued.revision,
					mode: "steer",
				})
			).status,
		).toBe(200);
		const steered = (
			(await (await call("messages")).json()) as {
				data: { queue: { steering: string[]; followUp: string[]; revision: number } };
			}
		).data.queue;
		expect(steered.steering).toEqual(["选中立即发送"]);
		expect(steered.followUp).toEqual(["保留继续排队"]);
		expect(providerRequests).toHaveLength(4);
		const dispatch = {
			index: 0,
			behavior: "steer",
			expectedText: "选中立即发送",
			revision: steered.revision,
			mode: "stop",
		};
		const dispatchRace = await Promise.all([
			call("queue/dispatch", "POST", { ...dispatch, requestId: crypto.randomUUID() }),
			call("queue/dispatch", "POST", { ...dispatch, requestId: crypto.randomUUID() }),
		]);
		expect(dispatchRace.map((response) => response.status).sort()).toEqual([200, 409]);
		await waitFor(() => providerRequests.length === 5);
		const preserved = (
			(await (await call("messages")).json()) as { data: { queue: { followUp: string[] } } }
		).data.queue;
		expect(preserved.followUp).toEqual(["保留继续排队"]);
		releaseQueuedRun();
		releaseSelectedRun();
		await waitFor(() => providerRequests.length === 6);
		const mismatch = await fetch(`${base}/api/session/info`, {
			headers: { ...headers, "x-workspace-dir": Buffer.from(root).toString("base64url") },
		});
		expect(mismatch.status).not.toBe(200);
		expect((await call("close", "POST")).status).toBe(200);
	} finally {
		releaseFirst();
		releaseQueuedRun();
		releaseSelectedRun();
		for (const aborter of aborters) aborter.abort();
		child.kill();
		await child.exited;
		provider.stop(true);
	}
}, 20_000);
