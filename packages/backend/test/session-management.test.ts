import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env";
import { SessionRegistry } from "../src/modules/agent/session-registry";
import { configureTestModels } from "./helpers";

for (const restart of [false, true])
	test(`failed deletion remains visible and cleans safely with restart=${restart}`, async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-delete-failure-"));
		const original = env.dataDir;
		(env as { dataDir: string }).dataDir = join(temp, "data");
		const cwd = join(temp, "project");
		mkdirSync(cwd);
		const registry = new SessionRegistry();
		const next = new SessionRegistry();
		const user = { userId: "delete-user", username: "user" };
		configureTestModels(user.userId);
		try {
			const ctx = await registry.create(user, cwd);
			const row = registry.catalog().require(user.userId, ctx.sessionId);
			spyOn(registry.catalog(), "finishDelete").mockImplementationOnce(() => {
				throw new Error("database temporarily unavailable");
			});
			await expect(
				registry.deleteSession(user.userId, ctx.sessionId, row.revision, true),
			).rejects.toThrow();
			const failed = registry
				.listCatalog(user.userId)
				.sessions.find((item) => item.sessionId === ctx.sessionId);
			expect(failed?.lifecycle).toBe("deleting");
			expect(failed?.managementError).toBeTruthy();
			await expect(registry.create(user, cwd, ctx.sessionId)).rejects.toThrow("已删除");
			if (restart) {
				await registry.stop({ preserveRunning: true });
				await next.recoverPersisted([user]);
				expect(next.listCatalog(user.userId).sessions).toEqual([]);
			} else {
				await registry.deleteSession(user.userId, ctx.sessionId, row.revision, true);
				expect(registry.listCatalog(user.userId).sessions).toEqual([]);
			}
		} finally {
			await registry.stop();
			await next.stop();
			(env as { dataDir: string }).dataDir = original;
			rmSync(temp, { recursive: true, force: true });
		}
	});

test("a renamed empty session can be resumed after restart without inventing history", async () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-empty-restart-"));
	const original = env.dataDir;
	(env as { dataDir: string }).dataDir = join(temp, "data");
	const cwd = join(temp, "project");
	mkdirSync(cwd);
	const first = new SessionRegistry();
	const next = new SessionRegistry();
	const user = { userId: "empty-user", username: "user" };
	configureTestModels(user.userId);
	try {
		const ctx = await first.create(user, cwd);
		const row = first.catalog().require(user.userId, ctx.sessionId);
		await first.updateSession(user.userId, ctx.sessionId, row.revision, { name: "空白计划" });
		await first.stop({ preserveRunning: true });
		const resumed = await next.create(user, cwd, ctx.sessionId);
		expect(resumed.session.sessionManager.getSessionName()).toBe("空白计划");
		expect(resumed.session.messages.filter((message) => message.role === "user")).toHaveLength(0);
		await expect(next.create(user, join(temp, "other"), ctx.sessionId)).rejects.toThrow();
	} finally {
		await first.stop();
		await next.stop();
		(env as { dataDir: string }).dataDir = original;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("empty sessions are managed without a JSONL, rename persists and deletion cannot remove project files or revive", async () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-management-"));
	const original = env.dataDir;
	(env as { dataDir: string }).dataDir = join(temp, "data");
	const cwd = join(temp, "project");
	mkdirSync(cwd);
	const registry = new SessionRegistry();
	const user = { userId: "management-user", username: "user" };
	configureTestModels(user.userId);
	try {
		const ctx = await registry.create(user, cwd);
		expect(registry.listSessions(user.userId, cwd)).toHaveLength(1);
		ctx.session.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		let row = registry.catalog().require(user.userId, ctx.sessionId);
		await registry.updateSession(user.userId, ctx.sessionId, row.revision, { name: "renamed" });
		expect(ctx.session.sessionManager.getSessionName()).toBe("renamed");
		row = registry.catalog().require(user.userId, ctx.sessionId);
		writeFileSync(join(cwd, "keep.txt"), "keep");
		const approval = ctx.approvals.create("tool_permission", "running-delete", {
			toolName: "read",
			runMode: "safe",
			input: { path: "keep.txt" },
		});
		await expect(
			registry.deleteSession(user.userId, ctx.sessionId, row.revision, false),
		).rejects.toThrow("确认停止");
		await registry.deleteSession(user.userId, ctx.sessionId, row.revision, true);
		await approval;
		expect(ctx.approvals.pendingList()).toHaveLength(0);
		expect(readFileSync(join(cwd, "keep.txt"), "utf8")).toBe("keep");
		expect(registry.listSessions(user.userId, cwd)).toEqual([]);
		await expect(registry.create(user, cwd, ctx.sessionId)).rejects.toThrow("已删除");
	} finally {
		await registry.stop();
		(env as { dataDir: string }).dataDir = original;
		rmSync(temp, { recursive: true, force: true });
	}
});
