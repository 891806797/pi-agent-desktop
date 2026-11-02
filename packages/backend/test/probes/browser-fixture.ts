import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openRuntimeDatabase } from "../../src/db";
import { users as usersTable } from "../../src/db/schema";
import { extensionBrowserHarness } from "./extension-browser-harness";
import { waitForServer } from "./server-startup";

// 仅供 browser_acceptance.py：编译版 + 临时数据 + 本机 Provider，不读取开发环境的密钥。
const root = mkdtempSync(join(tmpdir(), "pi-browser-"));
const workspaces = [join(root, "project-a"), join(root, "project-b")];
for (const workspace of workspaces) mkdirSync(workspace);
writeFileSync(
	join(workspaces[0]!, "long.txt"),
	`${Array.from({ length: 190 }, (_, index) => `line ${index + 1}: native pi tool output`).join("\n")}\nWEB_TOOL_OUTPUT_TAIL`,
);
const dataDir = join(root, "data");
const releases = new Set<() => void>();
const provider = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const body = (await request.json()) as { messages: Array<{ role: string; content: unknown }> };
		const lastUser = body.messages.findLastIndex((message) => message.role === "user");
		const userContent = body.messages[lastUser]?.content;
		const text =
			typeof userContent === "string"
				? userContent
				: Array.isArray(userContent)
					? userContent
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("")
					: "";
		const afterTool = body.messages.slice(lastUser + 1).some((message) => message.role === "tool");
		if (text === "browser-fail")
			return Response.json(
				{ error: { message: "browser fixture failure", type: "invalid_request_error" } },
				{ status: 400 },
			);
		const tool =
			!afterTool && text === "browser-permission"
				? {
						name: "write",
						arguments: JSON.stringify({ path: "browser.txt", content: "browser fixture" }),
					}
				: !afterTool && (text === "browser-question" || text === "browser-question-long")
					? {
							name: "ask_user_question",
							arguments: JSON.stringify({
								questions: Array.from(
									{ length: text === "browser-question-long" ? 8 : 1 },
									(_, index) => ({
										question:
											text === "browser-question-long"
												? `长问卷问题 ${index + 1}`
												: "浏览器验收选择",
										options:
											text === "browser-question-long"
												? Array.from({ length: 40 }, (_, option) => ({
														label: `选项 ${option + 1}`,
														description: "用于验证问卷内容滚动，标题和操作按钮保持固定。",
													}))
												: [{ label: "继续验收" }],
										allowCustom: false,
									}),
								),
							}),
						}
					: !afterTool && text === "browser-long-read"
						? { name: "read", arguments: JSON.stringify({ path: "long.txt" }) }
						: null;
		const streaming = text === "browser-thinking";
		const heldPermission = !afterTool && text === "browser-permission";
		return new Response(
			new ReadableStream({
				async start(controller) {
					const emit = (delta: unknown, reason: string | null = null) =>
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ id: "browser", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: reason }], ...(reason ? { usage: { prompt_tokens: 5120, completion_tokens: 128, total_tokens: 5248, prompt_tokens_details: { cached_tokens: 4096 } } } : {}) })}\n\n`,
							),
						);
					try {
						if (streaming || heldPermission) {
							emit({ role: "assistant", reasoning_content: "浏览器验收等待中" });
							await new Promise<void>((resolve) => {
								releases.add(resolve);
							});
						}
						if (tool) {
							emit({
								role: "assistant",
								tool_calls: [
									{
										index: 0,
										id: `browser_${tool.name}`,
										type: "function",
										function: { name: tool.name, arguments: "" },
									},
								],
							});
							// 穿过真实 SDK 的增量解析与 SSE 桥；分片覆盖中文、JSON 转义和长问卷。
							for (let offset = 0; offset < tool.arguments.length; offset += 17) {
								emit({
									tool_calls: [
										{
											index: 0,
											function: { arguments: tool.arguments.slice(offset, offset + 17) },
										},
									],
								});
							}
						} else if (text === "browser-scroll") {
							emit({
								role: "assistant",
								content: Array.from(
									{ length: 100 },
									(_, index) => `流式滚动 ${index}：测试消息跟随。\n\n`,
								).join(""),
							});
							await new Promise<void>((resolve) => {
								releases.add(resolve);
							});
							for (let index = 100; index < 240; index++) {
								emit({ content: `流式滚动 ${index}：持续追加内容。\n\n` });
								await Bun.sleep(12);
							}
						} else emit({ role: "assistant", content: "浏览器验收已完成" });
						emit({}, tool ? "tool_calls" : "stop");
						controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
						controller.close();
					} catch {
						/* 浏览器停止当前请求，允许连接被 SDK 中止。 */
					}
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});
let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
async function launch() {
	child = Bun.spawn([resolve(Bun.argv[2]!)], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			TEMP: tmpdir(),
			TMP: tmpdir(),
			USERPROFILE: process.env.USERPROFILE,
			PI_OFFLINE: "1",
			HOST: "127.0.0.1",
			PORT: base ? new URL(base).port : "0",
			DATA_DIR: dataDir,
			WORKSPACE_ROOTS: workspaces.join(";"),
			JWT_SECRET: "isolated-browser-development",
			SSE_HEARTBEAT_SEC: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	void (async () => {
		for await (const chunk of child.stderr) process.stderr.write(chunk);
	})();
	try {
		base = await waitForServer(child.stdout);
	} catch (error) {
		child.kill();
		provider.stop(true);
		throw error;
	}
}
await launch();
let stopped!: () => void;
const stopping = new Promise<void>((resolve) => {
	stopped = resolve;
});
const extensionHarness = extensionBrowserHarness();
const control = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const extensionResponse = await extensionHarness.handle(request);
		if (extensionResponse) return extensionResponse;
		const path = new URL(request.url).pathname;
		if (path === "/restart") {
			child.kill("SIGKILL");
			await child.exited;
			await launch();
			return Response.json({ base });
		}
		if (path === "/prepare") {
			const database = openRuntimeDatabase(join(dataDir, "runtime.sqlite"));
			const users = database.select({ id: usersTable.id }).from(usersTable).all();
			database.$client.close(true);
			const agentDir = join(dataDir, "users", users[0]!.id, "agent");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					compaction: { enabled: false, keepRecentTokens: 1024, reserveTokens: 512 },
				}),
			);
			const models = {
				providers: {
					fixture: {
						api: "openai-completions",
						apiKey: "browser-fixture",
						baseUrl: `http://127.0.0.1:${provider.port}/v1`,
						models: [
							{ id: "browser-fixture", reasoning: true, contextWindow: 32768, maxTokens: 1024 },
						],
					},
				},
			};
			writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));
			return Response.json({ models });
		}
		if (path === "/release") {
			for (const release of releases) release();
			releases.clear();
		}
		if (path === "/stop") {
			extensionHarness.dispose();
			setTimeout(() => {
				child.kill();
				provider.stop(true);
				control.stop(true);
				stopped();
			}, 20);
		}
		return Response.json({ ok: true });
	},
});
console.log(
	JSON.stringify({
		base,
		control: `http://127.0.0.1:${control.port}`,
		workspaces: workspaces.map((path) => Buffer.from(path).toString("base64url")),
	}),
);
await stopping;
provider.stop(true);
control.stop(true);
