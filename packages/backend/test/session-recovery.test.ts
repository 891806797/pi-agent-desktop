import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { env } from "../src/env";
import { captureQueuedImages } from "../src/modules/agent/queue-operations";
import { RuntimeStore } from "../src/modules/agent/runtime-store";
import { SessionRegistry } from "../src/modules/agent/session-registry";

const originalData = env.dataDir;
afterEach(() => {
	(env as { dataDir: string }).dataDir = originalData;
});

test("failed approval persistence retains the card and cannot leak an uncommitted allow into shutdown", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-recovery-io-"));
	(env as { dataDir: string }).dataDir = join(dir, "data");
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	const registry = new SessionRegistry();
	try {
		const ctx = await registry.create({ userId: "io-user", username: "io" }, cwd);
		ctx.recovery!.onEvent({ type: "agent_start" });
		void ctx.approvals.create("ui_confirm", "io", { title: "confirm", message: "continue?" });
		const write = spyOn(RuntimeStore.prototype, "write").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		try {
			expect(() => ctx.approvals.settle("io", { action: "allow" })).toThrow("disk full");
			expect(ctx.approvals.pendingList()).toHaveLength(1);
		} finally {
			write.mockRestore();
		}
		const errors: unknown[] = [];
		ctx.bus.subscribe((event) => {
			if (event.event === "error") errors.push(event);
		});
		const deferredWrite = spyOn(RuntimeStore.prototype, "write").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		try {
			ctx.recovery!.onEvent({
				type: "message_end",
				message: { role: "user", content: "test", timestamp: 1 },
			});
			await Promise.resolve();
			expect(errors).toHaveLength(1);
		} finally {
			deferredWrite.mockRestore();
		}
		await registry.stop({ preserveRunning: true });
		const store = new RuntimeStore(join(env.dataDir, "runtime.sqlite"));
		try {
			expect(store.read("io-user", ctx.sessionId)!.approvals[0]!.outcome).toBeUndefined();
		} finally {
			store.close();
		}
	} finally {
		await registry.stop({ preserveRunning: true });
		rmSync(dir, { recursive: true, force: true });
	}
});

async function interrupted(
	completed: boolean,
	stopReason: "toolUse" | "length" | "error" | "aborted" = "toolUse",
) {
	const dir = mkdtempSync(join(tmpdir(), "pi-recovery-policy-"));
	(env as { dataDir: string }).dataDir = join(dir, "data");
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	const user = { userId: "recovery-user", username: "recovery" };
	const first = new SessionRegistry();
	const next = new SessionRegistry();
	const ctx = await first.create(user, cwd);
	const call = {
		type: "toolCall" as const,
		id: "interrupted-write",
		name: "write",
		arguments: { path: "target.txt", content: "must not be repeated" },
	};
	ctx.session.sessionManager.appendMessage({ role: "user", content: "write once", timestamp: 1 });
	ctx.session.sessionManager.appendMessage({
		role: "assistant",
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		content: [call],
		stopReason,
		timestamp: 2,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	ctx.session.agent.state.messages = ctx.session.sessionManager.buildSessionContext().messages;
	ctx.recovery!.onEvent({ type: "agent_start" });
	if (stopReason === "toolUse")
		ctx.recovery!.onEvent({
			type: "tool_execution_start",
			toolCallId: call.id,
			toolName: call.name,
			args: call.arguments,
		});
	writeFileSync(join(cwd, "target.txt"), "already written");
	if (completed)
		ctx.recovery!.onEvent({
			type: "tool_execution_end",
			toolCallId: call.id,
			toolName: call.name,
			result: { content: [{ type: "text", text: "durable completed result" }], details: {} },
			isError: false,
		});
	await first.stop({ preserveRunning: true });
	const continueRun = spyOn(AgentSession.prototype, "sendCustomMessage").mockResolvedValue();
	const restored = await next.create(user, cwd, ctx.sessionId);
	return {
		restored,
		continueRun,
		cwd,
		cleanup: async () => {
			await next.stop();
			continueRun.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("unknown side effects pause for confirmation and are never automatically executed again", async () => {
	const f = await interrupted(false);
	try {
		expect(f.continueRun).not.toHaveBeenCalled();
		const pending = f.restored.approvals.pendingList();
		expect(pending).toHaveLength(1);
		expect(pending[0]!.kind).toBe("ui_confirm");
		expect(readFileSync(join(f.cwd, "target.txt"), "utf8")).toBe("already written");
		f.restored.approvals.settle(pending[0]!.requestId, { action: "answer", data: true });
		await f.restored.recovery!.wait();
		expect(f.continueRun).toHaveBeenCalledTimes(1);
		expect(readFileSync(join(f.cwd, "target.txt"), "utf8")).toBe("already written");
	} finally {
		await f.cleanup();
	}
});

for (const reason of ["length", "error", "aborted"] as const)
	test(`restart never executes tools from an assistant terminated with ${reason}`, async () => {
		const f = await interrupted(false, reason);
		try {
			await f.restored.recovery!.wait();
			expect(readFileSync(join(f.cwd, "target.txt"), "utf8")).toBe("already written");
			expect(
				f.restored.session.messages.some(
					(message) =>
						message.role === "toolResult" &&
						message.toolCallId === "interrupted-write" &&
						message.isError,
				),
			).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

test("a durably completed tool result missing from JSONL is appended without re-executing the tool", async () => {
	const f = await interrupted(true);
	try {
		await f.restored.recovery!.wait();
		expect(f.restored.approvals.pendingList()).toEqual([]);
		expect(
			f.restored.session.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.toolCallId === "interrupted-write" &&
					message.content.some(
						(part) => part.type === "text" && part.text === "durable completed result",
					),
			),
		).toBe(true);
		expect(f.continueRun).toHaveBeenCalledTimes(1);
		expect(readFileSync(join(f.cwd, "target.txt"), "utf8")).toBe("already written");
	} finally {
		await f.cleanup();
	}
});

test("native SDK recovery consumes identical queued text with each input's own image exactly once", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-recovery-images-"));
	(env as { dataDir: string }).dataDir = join(dir, "data");
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	const received: string[] = [];
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const body = (await request.json()) as {
				messages: Array<{ role: string; content: unknown }>;
			};
			received.push(
				JSON.stringify(body.messages.findLast((message) => message.role === "user")?.content),
			);
			return new Response(
				`data: ${JSON.stringify({ id: "images", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const user = { userId: "images-user", username: "images" };
	const agentDir = join(env.dataDir, "users", user.userId, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "fixture",
			defaultModel: "fixture",
			defaultThinkingLevel: "off",
			images: { autoResize: false },
		}),
	);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
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
		}),
	);
	const first = new SessionRegistry();
	const next = new SessionRegistry();
	try {
		const ctx = await first.create(user, cwd);
		await ctx.session.setModel(
			(await first.modelRuntimeFor(user.userId)).getModel("fixture", "fixture")!,
		);
		const images = [
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hGAAAAAASUVORK5CYII=",
		].map((data) => [{ type: "image" as const, mimeType: "image/png", data }]);
		const id = ctx.recovery!.beginInput("same", images[0], "followUp");
		ctx.recovery!.acceptInput(id, "started");
		const secondId = ctx.recovery!.beginInput("same", images[1], "followUp");
		await captureQueuedImages(
			ctx,
			images[1],
			() => ctx.session.followUp("same", images[1], { source: "rpc" }),
			secondId,
		);
		ctx.recovery!.acceptInput(secondId, "queued");
		await first.stop({ preserveRunning: true });
		const restored = await next.create(user, cwd, ctx.sessionId);
		await restored.recovery!.wait();
		expect(received).toHaveLength(2);
		expect(received[0]).toContain(images[0]![0]!.data);
		expect(received[1]).toContain(images[1]![0]!.data);
		expect(restored.session.getFollowUpMessages()).toEqual([]);
	} finally {
		await next.stop();
		await first.stop({ preserveRunning: true });
		provider.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
});
