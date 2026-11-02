import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { env } from "../src/env";
import { editSessionQueue, queueSnapshot } from "../src/modules/agent/queue-operations";
import { RuntimeStore } from "../src/modules/agent/runtime-store";
import { SessionRegistry } from "../src/modules/agent/session-registry";
import { configureTestModels } from "./helpers";

for (const scenario of [
	"accepted",
	"started",
	"response",
	"consumed-followup",
	"ended",
	"ended-with-queue",
]) {
	const completed = ["response", "consumed-followup", "ended", "ended-with-queue"].includes(
		scenario,
	);
	const laterUser = scenario === "consumed-followup";
	const queued = scenario === "ended-with-queue";
	test(`restart reconciles accepted intent at ${scenario}`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-action-crash-"));
		const original = env.dataDir;
		(env as { dataDir: string }).dataDir = join(dir, "data");
		const cwd = join(dir, "project");
		mkdirSync(cwd);
		const first = new SessionRegistry();
		const next = new SessionRegistry();
		const continuation = spyOn(AgentSession.prototype, "sendCustomMessage").mockResolvedValue();
		const prompt = spyOn(AgentSession.prototype, "prompt").mockResolvedValue();
		const user = { userId: "action-crash", username: "action" };
		configureTestModels(user.userId);
		try {
			const ctx = await first.create(user, cwd);
			ctx.session.sessionManager.appendMessage({ role: "user", content: "original", timestamp: 1 });
			ctx.recovery!.onEvent({ type: "agent_start" });
			const store = new RuntimeStore(join(env.dataDir, "runtime.sqlite"));
			try {
				const state = store.read(user.userId, ctx.sessionId)!;
				state.intent = { actionId: "accepted", attemptId: "attempt", issueId: "failed" };
				state.inputs = queued
					? [
							{
								id: "queued",
								text: "next task",
								phase: "queued",
								behavior: "followUp",
								prepared: true,
							},
						]
					: [];
				store.write(state);
				if (scenario !== "accepted")
					ctx.session.sessionManager.appendCustomEntry("web_run_attempt", {
						...state.intent,
						status: "started",
					});
				if (completed)
					ctx.session.sessionManager.appendMessage({
						role: "assistant",
						content: [{ type: "text", text: "already done" }],
						stopReason: "stop",
						timestamp: 2,
						api: "openai-completions",
						provider: "fixture",
						model: "fixture",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					} as never);
				if (scenario.startsWith("ended"))
					ctx.session.sessionManager.appendCustomEntry("web_run_attempt", {
						...state.intent,
						status: "completed",
					});
				if (laterUser)
					ctx.session.sessionManager.appendMessage({
						role: "user",
						content: "follow up already consumed",
						timestamp: 3,
					});
			} finally {
				store.close();
			}
			// 强制退出窗口：不让旧宿主再覆盖手工写入的持久化检查点。
			const restored = await next.create(user, cwd, ctx.sessionId);
			await restored.recovery!.wait();
			expect(next.catalog().require(user.userId, ctx.sessionId).recovering).toBe(false);
			expect(continuation).toHaveBeenCalledTimes(completed && !laterUser ? 0 : 1);
			expect(prompt).toHaveBeenCalledTimes(queued ? 1 : 0);
			expect(restored.session.messages.filter((message) => message.role === "user")).toHaveLength(
				laterUser ? 2 : 1,
			);
		} finally {
			continuation.mockRestore();
			prompt.mockRestore();
			await first.stop();
			await next.stop();
			(env as { dataDir: string }).dataDir = original;
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("an unresolved issue survives a restart without automatically issuing a model request", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-issue-pause-"));
	const original = env.dataDir;
	(env as { dataDir: string }).dataDir = join(dir, "data");
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	const first = new SessionRegistry(),
		next = new SessionRegistry();
	const user = { userId: "pause-user", username: "pause" };
	configureTestModels(user.userId);
	const continuation = spyOn(AgentSession.prototype, "sendCustomMessage").mockResolvedValue();
	try {
		const ctx = await first.create(user, cwd);
		ctx.session.sessionManager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const store = new RuntimeStore(join(env.dataDir, "runtime.sqlite"));
		const issue = {
			issueId: "paused",
			attemptId: "attempt",
			revision: 1,
			kind: "model" as const,
			message: "failed",
			createdAt: 1,
			allowedActions: ["continue" as const, "abandon" as const],
		};
		try {
			store.write({
				version: 1,
				...user,
				sessionId: ctx.sessionId,
				cwd,
				active: false,
				inputs: [
					{
						id: "queued",
						text: "next task",
						behavior: "followUp",
						phase: "queued",
						prepared: true,
					},
				],
				approvals: [],
				tools: [],
				issue,
			});
		} finally {
			store.close();
		}
		const restored = await next.create(user, cwd, ctx.sessionId);
		await restored.recovery!.wait();
		expect(restored.recovery!.issue).toEqual(issue);
		expect(queueSnapshot(restored).followUp).toEqual(["next task"]);
		expect(continuation).not.toHaveBeenCalled();
		continuation.mockRejectedValueOnce(new Error("continuation unavailable"));
		await restored.recovery!.applyAction({
			actionId: crypto.randomUUID(),
			issueId: issue.issueId,
			expectedRevision: issue.revision,
			action: "continue",
		});
		await restored.recovery!.wait();
		expect(restored.recovery!.issue?.kind).toBe("recovery");
		expect(next.catalog().require(user.userId, ctx.sessionId).recovering).toBe(false);
		expect(queueSnapshot(restored).followUp).toEqual(["next task"]);
		await editSessionQueue(restored, 0, "followUp", undefined, "next task");
		const updated = new RuntimeStore(join(env.dataDir, "runtime.sqlite"));
		try {
			expect(updated.read(user.userId, ctx.sessionId)!.inputs).toEqual([]);
		} finally {
			updated.close();
		}
	} finally {
		continuation.mockRestore();
		await first.stop();
		await next.stop();
		(env as { dataDir: string }).dataDir = original;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("terminal failures persist actionable issues; competing pages and lost responses cannot start recovery twice", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-actions-"));
	const original = env.dataDir;
	(env as { dataDir: string }).dataDir = join(dir, "data");
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	const registry = new SessionRegistry();
	const continuation = spyOn(AgentSession.prototype, "sendCustomMessage").mockResolvedValue();
	try {
		configureTestModels("action-user");
		const ctx = await registry.create({ userId: "action-user", username: "action" }, cwd);
		ctx.session.sessionManager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const failure = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "fixture failure",
			timestamp: 2,
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as const;
		ctx.session.sessionManager.appendMessage(failure as never);
		ctx.session.agent.state.messages = ctx.session.sessionManager.buildSessionContext().messages;
		ctx.recovery!.onEvent({ type: "agent_settled", aborted: false });
		const issue = ctx.recovery!.issue;
		expect(issue?.allowedActions).toContain("continue");
		const action = {
			actionId: crypto.randomUUID(),
			issueId: issue!.issueId,
			expectedRevision: issue!.revision,
			action: "continue" as const,
		};
		await ctx.recovery!.applyAction(action);
		await ctx.recovery!.applyAction(action);
		await expect(
			ctx.recovery!.applyAction({ ...action, actionId: crypto.randomUUID() }),
		).rejects.toThrow();
		await ctx.recovery!.wait();
		expect(continuation).toHaveBeenCalledTimes(1);
		expect(ctx.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	} finally {
		continuation.mockRestore();
		await registry.stop();
		(env as { dataDir: string }).dataDir = original;
		rmSync(dir, { recursive: true, force: true });
	}
});
