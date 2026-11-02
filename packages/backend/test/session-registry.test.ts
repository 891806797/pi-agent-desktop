import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { env } from "@/env";
import { setModel } from "@/modules/agent/agent.service";
import { SessionRegistry, registry as serviceRegistry } from "@/modules/agent/session-registry";
import { userSessionsDir } from "@/modules/system/paths";
import { configureTestModels } from "./helpers";

const temp = mkdtempSync(join(tmpdir(), "pi-registry-"));
const originalData = env.dataDir;
const user = { userId: "registry-test", username: "test" };
let registries: SessionRegistry[] = [];
function setup() {
	(env as { dataDir: string }).dataDir = temp;
	configureTestModels(user.userId);
	const registry = new SessionRegistry();
	registries.push(registry);
	const cwd = join(temp, crypto.randomUUID());
	mkdirSync(cwd);
	return { registry, cwd };
}
afterEach(async () => {
	for (const registry of registries) await registry.stop();
	registries = [];
	(env as { dataDir: string }).dataDir = originalData;
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));
describe("SessionRegistry 生命周期", () => {
	test("会话列表从 SDK 内容块数组读取首条消息摘要，不把已有会话显示为新会话", () => {
		const { registry, cwd } = setup();
		const sm = SessionManager.create(cwd, userSessionsDir(user.userId));
		sm.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "项目讨论" },
				{ type: "image", data: "fixture", mimeType: "image/png" },
			],
			timestamp: 1,
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "收到" }],
			timestamp: 2,
		} as never);
		expect(registry.listSessions(user.userId, cwd)).toMatchObject([
			{ sessionId: sm.getSessionId(), firstMessage: "项目讨论" },
		]);
	});
	test("关闭等待 SDK 模型认证与最后一次配置写入，释放前不能恢复旧实例", async () => {
		const { registry, cwd } = setup();
		const ctx = await registry.create(user, cwd);
		const runtime = await registry.modelRuntimeFor(user.userId);
		const model = runtime.getModels("fixture")[0]!;
		let release!: (allowed: Awaited<ReturnType<typeof runtime.checkAuth>>) => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const authenticate = spyOn(runtime, "checkAuth").mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
					entered();
				}),
		);
		const runtimeLookup = spyOn(serviceRegistry, "modelRuntimeFor").mockResolvedValue(runtime);
		const dispose = spyOn(ctx.session, "dispose");
		const changing = setModel(user, ctx, model.provider, model.id);
		try {
			await started;
			const closing = registry.close(ctx.sessionId, "user_close");
			await Bun.sleep(0);
			expect(dispose).not.toHaveBeenCalled();
			expect(registry.liveCount()).toBe(1);
			release({ type: "api_key" });
			await Promise.all([changing, closing]);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(registry.liveCount()).toBe(0);
		} finally {
			release({ type: "api_key" });
			await changing.catch(() => {});
			authenticate.mockRestore();
			runtimeLookup.mockRestore();
			dispose.mockRestore();
		}
	});
	test("abort 失败时阻止恢复，重试关闭成功才释放占位", async () => {
		const { registry, cwd } = setup();
		const ctx = await registry.create(user, cwd);
		const abort = spyOn(ctx.session, "abort").mockRejectedValue(new Error("abort failure"));
		try {
			await expect(registry.close(ctx.sessionId, "user_close")).rejects.toThrow("abort failure");
			await expect(registry.create(user, cwd, ctx.sessionId)).rejects.toThrow("会话关闭失败");
			expect(registry.liveCount()).toBe(1);
		} finally {
			abort.mockRestore();
		}
		await registry.close(ctx.sessionId, "user_close");
		expect(registry.liveCount()).toBe(0);
	});
	test("保留 SDK 恢复的可用模型，不覆盖为列表首项", async () => {
		const { registry, cwd } = setup();
		const runtime = await registry.modelRuntimeFor(user.userId);
		const models = runtime.getModels("fixture").slice(0, 2);
		expect(models.length).toBe(2);

		const originalBind = AgentSession.prototype.bindExtensions;
		const bind = spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (
			this: AgentSession,
			bindings,
		) {
			await originalBind.call(this, bindings);
			this.agent.state.model = models[1]!;
		});
		const setModel = spyOn(AgentSession.prototype, "setModel");
		try {
			const ctx = await registry.create(user, cwd);
			expect(ctx.session.model?.id).toBe(models[1]!.id);
			expect(setModel).not.toHaveBeenCalled();
		} finally {
			bind.mockRestore();
			setModel.mockRestore();
		}
	});
	test("等待 fallback 模型实际切换，SDK 拒绝时创建失败", async () => {
		const { registry, cwd } = setup();
		const runtime = await registry.modelRuntimeFor(user.userId);
		const models = runtime.getModels("fixture").slice(0, 2);
		models[1] = runtime.getModels("deepseek")[0]!;
		const originalBind = AgentSession.prototype.bindExtensions;
		const bind = spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (
			this: AgentSession,
			bindings,
		) {
			await originalBind.call(this, bindings);
			this.agent.state.model = models[1]!;
		});
		const setModel = spyOn(AgentSession.prototype, "setModel").mockImplementation(async () => {
			await Promise.resolve();
			throw new Error("model switch failure");
		});
		try {
			await expect(registry.create(user, cwd)).rejects.toThrow("model switch failure");
			expect(registry.liveCount()).toBe(0);
		} finally {
			bind.mockRestore();
			setModel.mockRestore();
		}
	});
	test("janitor 保留运行中与等待审批的会话", async () => {
		const { registry, cwd } = setup();
		const running = await registry.create(user, cwd);
		const pending = await registry.create(user, cwd);
		const queued = await registry.create(user, cwd);
		await queued.session.steer("待处理输入");
		running.bus.publish({ event: "status", data: { status: "responding" } });
		void pending.approvals.create("tool_permission", "pending", {
			toolName: "write",
			input: {},
			runMode: "standard",
		});
		running.lastActiveAt = pending.lastActiveAt = queued.lastActiveAt = 0;
		const config = env as { janitorIntervalSec: number; idleGcMinutes: number };
		const original = {
			janitorIntervalSec: env.janitorIntervalSec,
			idleGcMinutes: env.idleGcMinutes,
		};
		try {
			config.janitorIntervalSec = 0.005;
			config.idleGcMinutes = 0;
			registry.startJanitor();
			await Bun.sleep(20);
			expect(registry.liveCount()).toBe(3);
		} finally {
			Object.assign(config, original);
			await registry.stop();
		}
	});
	test("并发恢复同一历史会话只创建一个实例", async () => {
		const { registry, cwd } = setup();
		const sm = SessionManager.create(cwd, userSessionsDir(user.userId));
		writeFileSync(sm.getSessionFile()!, `${JSON.stringify(sm.getHeader())}\n`);
		const contexts = await Promise.all(
			Array.from({ length: 5 }, () => registry.create(user, cwd, sm.getSessionId())),
		);
		expect(contexts.every((ctx) => ctx === contexts[0])).toBe(true);
		expect(registry.liveCount()).toBe(1);
	});
	test("扩展异步绑定失败会清理资源并释放配额", async () => {
		const { registry, cwd } = setup();
		const bind = spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async () => {
			await Promise.resolve();
			throw new Error("bind failure");
		});
		const dispose = spyOn(AgentSession.prototype, "dispose");
		try {
			await expect(registry.create(user, cwd)).rejects.toThrow("bind failure");
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(registry.liveCount()).toBe(0);
		} finally {
			bind.mockRestore();
			dispose.mockRestore();
		}
		const contexts = await Promise.all(
			Array.from({ length: env.maxSessionsPerUser }, () => registry.create(user, cwd)),
		);
		expect(contexts.length).toBe(env.maxSessionsPerUser);
	});
	test("刷新模型沿用活跃会话共享的运行时", async () => {
		const { registry, cwd } = setup();
		const ctx = await registry.create(user, cwd);
		const runtime = await registry.modelRuntimeFor(user.userId);
		const refresh = spyOn(runtime, "refresh");
		await registry.invalidateModelRuntime(user.userId);
		expect(await registry.modelRuntimeFor(user.userId)).toBe(runtime);
		expect(ctx.session.modelRuntime).toBe(runtime);
		expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
	});
	test("status 快照沿用总线实际状态", async () => {
		const { registry, cwd } = setup();
		const ctx = await registry.create(user, cwd);
		ctx.bus.publish({ event: "status", data: { status: "awaiting-approval" } });
		expect(ctx.status).toBe("awaiting-approval");
	});
	test("磁盘扩展在执行前禁用，内联扩展仍加载", async () => {
		const { registry, cwd } = setup();
		const extensions = join(cwd, ".pi", "extensions");
		mkdirSync(extensions, { recursive: true });
		const marker = join(cwd, "executed");
		writeFileSync(
			join(extensions, "probe.ts"),
			`import {writeFileSync} from 'node:fs'; export default function(){writeFileSync(${JSON.stringify(marker)}, 'unsafe');}`,
		);
		const ctx = await registry.create(user, cwd);
		expect(existsSync(marker)).toBe(false);
		expect(ctx.resourceLoader.getExtensions().extensions.length).toBe(3);
	});
	test("活跃 resume 校验属主与工作区", async () => {
		const { registry, cwd } = setup();
		const ctx = await registry.create(user, cwd);
		await expect(
			registry.create({ userId: "other", username: "other" }, cwd, ctx.sessionId),
		).rejects.toThrow();
		await expect(registry.create(user, temp, ctx.sessionId)).rejects.toThrow();
		expect(registry.get(ctx.sessionId, user.userId, temp)).toBeUndefined();
	});
	test("配额包含正在创建的会话", async () => {
		const { registry, cwd } = setup();
		const results = await Promise.allSettled(
			Array.from({ length: env.maxSessionsPerUser + 1 }, () => registry.create(user, cwd)),
		);
		expect(results.filter((r) => r.status === "fulfilled").length).toBe(env.maxSessionsPerUser);
		expect(results.filter((r) => r.status === "rejected").length).toBe(1);
	});
	test("关闭等待 abort 完成并保持幂等", async () => {
		const { registry, cwd } = setup();
		const ctx = await registry.create(user, cwd);
		let release!: () => void;
		let started!: () => void;
		const abortStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const abort = spyOn(ctx.session, "abort").mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
					started();
				}),
		);
		const dispose = spyOn(ctx.session, "dispose");
		const close = registry.close(ctx.sessionId, "user_close");
		await abortStarted;
		expect(abort).toHaveBeenCalledTimes(1);
		expect(dispose).not.toHaveBeenCalled();
		const close2 = registry.close(ctx.sessionId, "user_close");
		release();
		await Promise.all([close, close2]);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(registry.liveCount()).toBe(0);
	});
});
