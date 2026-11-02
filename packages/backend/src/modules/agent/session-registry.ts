/**
 * 会话注册表 —— 活跃 in-process AgentSession 的生命周期管理（实施计划 §5.1）。
 *
 * 主键 sessionId（pi 生成的 uuidV7，与 JSONL 文件名同源）；workspace+sessionId 成对校验
 * （同一用户多工作区可能有会话，仅 sid 不足以定位）。配额 + janitor 空闲回收。
 */

import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentStatus, SessionCloseReason, SessionSummary } from "@pi-agent/common";
import { AppError } from "@/core/app-error";
import { env } from "@/env";
import { encodePath, userAgentDir, userSessionsDir } from "@/modules/system/paths";
import { resolveWorkspaceB64 } from "@/modules/system/workspace-registry";
import { ApprovalManager } from "./approval-manager";
import { getDefaultSettings } from "./default-settings.service";
import { SessionEventBus } from "./event-bus";
import { contentText, EventTranslator } from "./event-translator";
import { makeAskQuestionExt } from "./ext-ask-question";
import { makeRunModeGateExt, RunModeHolder } from "./ext-run-mode-gate";
import { configuredModels, makeModelConfigGateExt } from "./model-config";
import { queueSnapshot, queueTransaction } from "./queue-operations";
import { RuntimeStore } from "./runtime-store";
import { SessionCatalog } from "./session-catalog";
import { readSessionMetrics } from "./session-metrics";
import { SessionRecovery } from "./session-recovery";
import { SessionUI } from "./session-ui";
import { makeWebUIContext } from "./ui-context";

export interface SessionContext {
	sessionId: string;
	userId: string;
	username: string;
	cwd: string;
	createdAt: number;
	lastActiveAt: number;
	closing: boolean;
	session: AgentSession;
	resourceLoader: DefaultResourceLoader;
	bus: SessionEventBus;
	approvals: ApprovalManager;
	runMode: RunModeHolder;
	translator: EventTranslator;
	status: AgentStatus;
	recovery?: SessionRecovery;
	interrupted?: boolean;
	ui?: SessionUI;
	persistSettings?: () => void;
}

export class SessionRegistry {
	private sessionCatalog?: SessionCatalog;
	private indexedUsers = new Set<string>();
	catalog(): SessionCatalog {
		this.sessionCatalog ??= new SessionCatalog(join(env.dataDir, "runtime.sqlite"));
		return this.sessionCatalog;
	}
	private runtimeStore?: RuntimeStore;
	private runtimes(): RuntimeStore {
		this.runtimeStore ??= new RuntimeStore(join(env.dataDir, "runtime.sqlite"));
		return this.runtimeStore;
	}
	private map = new Map<string, SessionContext>();
	private modelRuntimes = new Map<string, Promise<ModelRuntime>>();
	private pending = new Map<string, Promise<SessionContext>>();
	private creating = new Map<string, number>();
	private closing = new Map<string, Promise<void>>();
	private starting = new Set<Promise<SessionContext>>();
	private stopped = false;
	private janitorTimer: Timer | undefined;

	/** per-user ModelRuntime 缓存（auth.json/models.json 在 per-user agentDir） */
	modelRuntimeFor(userId: string): Promise<ModelRuntime> {
		let cached = this.modelRuntimes.get(userId);
		if (!cached) {
			cached = ModelRuntime.create({
				authPath: join(userAgentDir(userId), "auth.json"),
				modelsPath: join(userAgentDir(userId), "models.json"),
			});
			this.modelRuntimes.set(userId, cached);
			void cached.catch(() => {
				if (this.modelRuntimes.get(userId) === cached) this.modelRuntimes.delete(userId);
			});
		}
		return cached;
	}

	/**
	 * 创建或 resume 会话（全进程内一次完成，实施计划 §5.1 九步）。
	 * 空白会话由属主目录恢复；已有历史丢失时不能创建空上下文掩盖问题。
	 */
	async create(
		user: { userId: string; username: string },
		cwd: string,
		resumeSessionId?: string,
	): Promise<SessionContext> {
		if (this.stopped) throw new AppError("SESSION_BUSY", "服务正在关闭");
		cwd = resolve(cwd);
		if (resumeSessionId) {
			this.catalog().assertAvailable(user.userId, resumeSessionId);
			const live = this.map.get(resumeSessionId);
			if (live) {
				if (live.userId !== user.userId || relative(live.cwd, cwd) !== "")
					throw new AppError("NOT_FOUND");
				if (live.closing) {
					const closing = this.closing.get(resumeSessionId);
					if (!closing) throw new AppError("SESSION_BUSY", "会话关闭失败，请重试关闭");
					await closing;
					return this.create(user, cwd, resumeSessionId);
				}
				return live;
			}
		}
		const workspaceKey = process.platform === "win32" ? cwd.toLowerCase() : cwd;
		const key = JSON.stringify([user.userId, workspaceKey, resumeSessionId]);
		if (resumeSessionId) {
			const pending = this.pending.get(key);
			if (pending) return pending;
		}
		const inFlight = [...this.creating.values()].reduce((a, b) => a + b, 0);
		const own = [...this.map.values()].filter((ctx) => ctx.userId === user.userId).length;
		if (
			this.map.size + inFlight >= env.maxSessionsTotal ||
			own + (this.creating.get(user.userId) ?? 0) >= env.maxSessionsPerUser
		) {
			throw new AppError("QUOTA_EXCEEDED");
		}
		this.creating.set(user.userId, (this.creating.get(user.userId) ?? 0) + 1);
		const work = this.createSession(user, cwd, resumeSessionId);
		this.starting.add(work);
		if (resumeSessionId) this.pending.set(key, work);
		try {
			return await work;
		} finally {
			this.starting.delete(work);
			this.creating.set(user.userId, (this.creating.get(user.userId) ?? 1) - 1);
			if (resumeSessionId) this.pending.delete(key);
		}
	}

	private async createSession(
		user: { userId: string; username: string },
		cwd: string,
		resumeSessionId?: string,
	): Promise<SessionContext> {
		const agentDir = userAgentDir(user.userId);
		const sessionsDir = userSessionsDir(user.userId);
		const modelRuntime = await this.modelRuntimeFor(user.userId);
		const saved = resumeSessionId ? this.runtimes().read(user.userId, resumeSessionId) : undefined;
		const savedSettings = resumeSessionId
			? this.runtimes().readSettings(user.userId, resumeSessionId)
			: undefined;
		const models = configuredModels(user.userId, modelRuntime);
		const preferences = savedSettings ?? getDefaultSettings(user.userId);
		const initialModel =
			models.find(
				(model) =>
					model.provider === preferences.model?.provider && model.id === preferences.model.modelId,
			) ?? models[0];
		if (!initialModel) throw new AppError("MODEL_NOT_FOUND", "请先在模型设置中配置模型");
		if (saved && relative(saved.cwd, cwd) !== "")
			throw new AppError("NOT_FOUND", "恢复工作区不匹配");

		let sessionManager: SessionManager;
		if (resumeSessionId) {
			const file = SessionManager.findById(cwd, resumeSessionId, sessionsDir);
			if (
				!file &&
				!saved?.inputs.length &&
				!this.catalog().canRestoreEmpty(user.userId, resumeSessionId, cwd)
			)
				throw new AppError("NOT_FOUND", "会话不存在（或属于其他工作空间）");
			sessionManager = file
				? SessionManager.open(file)
				: SessionManager.create(cwd, sessionsDir, { id: resumeSessionId });
			if (file) this.catalog().markHistory(user.userId, resumeSessionId);
			else {
				const name = this.catalog().get(user.userId, resumeSessionId)?.name;
				if (name) sessionManager.appendSessionInfo(name);
			}
		} else {
			sessionManager = SessionManager.create(cwd, sessionsDir);
		}

		const bus = new SessionEventBus();
		const approvals = new ApprovalManager(bus);
		const display = new SessionUI(bus, approvals);
		const initialRunMode = savedSettings?.runMode ?? "standard";
		const runMode = new RunModeHolder(initialRunMode, (mode) => {
			bus.publish({ event: "run_mode", data: { mode } });
		});

		// 工作区可读并不代表允许执行其中的配置代码。
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: [
				makeRunModeGateExt(runMode, approvals),
				makeAskQuestionExt(approvals),
				makeModelConfigGateExt(user.userId),
			],
			settingsManager,
			noExtensions: true,
		});
		await resourceLoader.reload();
		if (resourceLoader.getExtensions().errors.length > 0) {
			throw new AppError("AGENT_ERROR", "会话扩展初始化失败");
		}

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: initialModel,
			thinkingLevel: preferences.thinkingLevel,
			settingsManager,
			resourceLoader,
			sessionManager,
		});

		try {
			await session.bindExtensions({
				uiContext: makeWebUIContext(approvals, display),
				mode: "rpc",
				onError: (err: unknown) => {
					console.error(`[session ${session.sessionId}] extension error:`, err);
				},
			});

			const available = models;
			if (
				!available.some(
					(model) => model.provider === session.model?.provider && model.id === session.model?.id,
				) &&
				available[0]
			) {
				await session.setModel(available[0]);
			}
			if (savedSettings) {
				const preferred = available.find(
					(model) =>
						model.provider === savedSettings.model?.provider &&
						model.id === savedSettings.model.modelId,
				);
				if (preferred) await session.setModel(preferred);
				session.setThinkingLevel(savedSettings.thinkingLevel);
			}

			const ctx: SessionContext = {
				sessionId: session.sessionId,
				userId: user.userId,
				username: user.username,
				cwd,
				createdAt: Date.now(),
				lastActiveAt: Date.now(),
				closing: false,
				session,
				resourceLoader,
				bus,
				approvals,
				runMode,
				translator: new EventTranslator(),
				status: "idle",
				ui: display,
			};
			let lastSettings = "";
			ctx.persistSettings = () => {
				const settings = {
					model: session.model
						? { provider: session.model.provider, modelId: session.model.id }
						: null,
					thinkingLevel: session.thinkingLevel,
					runMode: runMode.mode,
				};
				const serialized = JSON.stringify(settings);
				if (serialized === lastSettings) return;
				this.runtimes().writeSettings(ctx.userId, ctx.sessionId, settings);
				lastSettings = serialized;
			};
			// 恢复中的工具执行可能早于下一次 agent_start。
			display.bindTools(session.agent.state.tools);
			ctx.recovery = new SessionRecovery(ctx, this.runtimes(), saved);

			let metricsScheduled = false;
			const scheduleMetrics = () => {
				if (metricsScheduled || ctx.closing) return;
				metricsScheduled = true;
				// SDK message_end 先通知监听器再落盘，微任务内读取才能包含本次响应。
				queueMicrotask(() => {
					metricsScheduled = false;
					if (!ctx.closing)
						bus.publish({ event: "session_metrics", data: readSessionMetrics(session) });
				});
			};
			bus.subscribe((ev) => {
				if (ev.event === "status") ctx.status = ev.data.status;
				if (["model_changed", "thinking_level_changed", "run_mode"].includes(ev.event))
					ctx.persistSettings?.();
				if (ev.event === "model_changed") scheduleMetrics();
				if (ev.event === "queue_update") ctx.recovery?.queueChanged();
			});
			session.subscribe((ev) => {
				if (ev.type === "agent_start") display.bindTools(session.agent.state.tools);
				if (ev.type === "agent_settled") display.flush();
				ctx.recovery?.onEvent(ev);
				ctx.lastActiveAt = Date.now();
				for (const sse of ctx.translator.translate(ev)) bus.publish(sse);
				if (
					ev.type === "message_end" ||
					ev.type === "entry_appended" ||
					ev.type === "compaction_end" ||
					ev.type === "agent_settled"
				)
					scheduleMetrics();
			});

			bus.publish({ event: "session", data: { sessionId: ctx.sessionId } });
			if (session.model) {
				bus.publish({
					event: "model_changed",
					data: { provider: session.model.provider, modelId: session.model.id },
				});
			}
			bus.publish({ event: "thinking_level_changed", data: { level: session.thinkingLevel } });
			bus.publish({ event: "run_mode", data: { mode: runMode.mode } });
			ctx.persistSettings();
			bus.publish({ event: "status", data: { status: "idle" } });
			scheduleMetrics();
			this.catalog().assertAvailable(user.userId, ctx.sessionId);
			this.catalog().upsert(user.userId, {
				sessionId: ctx.sessionId,
				workspace: cwd,
				firstMessage: "",
				createdAt: sessionManager.getHeader()?.timestamp,
			});
			this.catalog().project(user.userId, ctx.sessionId, { live: true, status: "idle" });
			this.map.set(ctx.sessionId, ctx);
			this.catalog().watch(ctx);
			if (
				saved &&
				(!saved.issue || saved.intent) &&
				(saved.active || saved.inputs.length || saved.approvals.some((item) => !item.outcome))
			)
				ctx.recovery.start();
			if (saved?.issue && !saved.intent) {
				ctx.recovery.restorePausedInputs();
				bus.publish({ event: "run_issue", data: { issue: saved.issue } });
				bus.publish({ event: "status", data: { status: "error" } });
			}
			return ctx;
		} catch (error) {
			display.dispose();
			approvals.rejectAll("会话初始化失败");
			try {
				await session.abort();
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				session.dispose();
			}
			throw error;
		}
	}

	/** 属主校验：非属主/不存在统一 undefined */
	get(sessionId: string, userId: string, cwd?: string): SessionContext | undefined {
		const ctx = this.map.get(sessionId);
		if (
			!ctx ||
			ctx.closing ||
			ctx.userId !== userId ||
			(cwd !== undefined && relative(ctx.cwd, cwd) !== "")
		)
			return undefined;
		ctx.lastActiveAt = Date.now();
		return ctx;
	}

	liveCount(): number {
		return this.map.size;
	}

	/** 在原实例刷新，活跃会话与设置页共享同一份认证和模型状态。 */
	async invalidateModelRuntime(userId: string): Promise<void> {
		const runtime = this.modelRuntimes.get(userId);
		if (runtime) await (await runtime).refresh({ allowNetwork: false });
	}

	/** 关闭期间保留注册表占位，等待最后一次写入和扩展退出后才允许恢复。 */
	close(sessionId: string, reason: SessionCloseReason): Promise<void> {
		const ongoing = this.closing.get(sessionId);
		if (ongoing) return ongoing;
		const ctx = this.map.get(sessionId);
		if (!ctx) return Promise.resolve();
		ctx.closing = true;
		const work = queueTransaction(ctx, () => this.closeContext(ctx, reason)).finally(() => {
			this.closing.delete(sessionId);
		});
		this.closing.set(sessionId, work);
		return work;
	}

	private async closeContext(ctx: SessionContext, reason: SessionCloseReason): Promise<void> {
		ctx.recovery?.cancel();
		ctx.approvals.rejectAll("会话已关闭");
		ctx.bus.publish({ event: "query_closed", data: { reason } });
		await ctx.session.abort();
		await ctx.recovery?.wait();
		try {
			await ctx.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await ctx.session.settingsManager.flush();
		} finally {
			ctx.session.dispose();
			ctx.ui?.dispose();
			ctx.recovery?.remove();
			this.map.delete(ctx.sessionId);
			this.catalog().project(ctx.userId, ctx.sessionId, {
				live: false,
				status: "idle",
				pendingPermissions: 0,
				pendingQuestions: 0,
			});
		}
	}

	/** 扫描 per-user 会话目录，live 标记来自注册表 */
	private reconcileUser(userId: string): void {
		if (this.indexedUsers.has(userId)) return;
		const dir = userSessionsDir(userId);
		try {
			for (const file of Array.from(new Bun.Glob("*.jsonl").scanSync({ cwd: dir }))) {
				try {
					const sm = SessionManager.open(join(dir, file));
					const header = sm.getHeader();
					if (!header) continue;
					const messages = sm.buildSessionContext().messages;
					const firstUser = messages.find((m) => m.role === "user");
					const firstText = contentText(firstUser?.content);
					this.catalog().upsert(userId, {
						sessionId: header.id,
						workspace: header.cwd,
						firstMessage: firstText.slice(0, 100),
						createdAt: header.timestamp,
						name: sm.getSessionName(),
					});
					this.catalog().markHistory(userId, header.id);
				} catch {
					// 单个损坏文件跳过，不阻断列表
				}
			}
		} catch {
			// 目录不可读返回空列表
		}
		this.indexedUsers.add(userId);
	}
	listSessions(userId: string, workspace?: string): SessionSummary[] {
		this.reconcileUser(userId);
		return this.catalog().list(userId, { workspace, limit: 100 }).sessions;
	}
	listCatalog(userId: string, query: import("@pi-agent/common").CatalogQuery = {}) {
		this.reconcileUser(userId);
		return this.catalog().list(userId, query);
	}
	async updateSession(
		userId: string,
		sessionId: string,
		revision: number,
		patch: { name?: string; archived?: boolean },
	) {
		const catalog = this.catalog();
		const row = catalog.require(userId, sessionId);
		catalog.assertAvailable(userId, sessionId);
		const ctx = this.get(sessionId, userId, row.workspace);
		const update = async () => {
			catalog.assertAvailable(userId, sessionId);
			const current = catalog.require(userId, sessionId);
			if (current.revision !== revision)
				throw new AppError("SESSION_BUSY", "会话已更新，请刷新后重试");
			if (patch.name !== undefined) {
				if (ctx) ctx.session.setSessionName(patch.name);
				else {
					const file = SessionManager.findById(row.workspace, sessionId, userSessionsDir(userId));
					if (file) SessionManager.open(file).appendSessionInfo(patch.name);
				}
			}
			return catalog.update(userId, sessionId, revision, patch);
		};
		return ctx ? queueTransaction(ctx, update) : update();
	}
	async deleteSession(userId: string, sessionId: string, revision: number, stopIfRunning: boolean) {
		const row = this.catalog().require(userId, sessionId);
		const ctx = this.map.get(sessionId);
		if (
			row.lifecycle === "normal" &&
			ctx &&
			(!ctx.session.isIdle || ctx.approvals.pendingList().length || ctx.recovery?.running) &&
			!stopIfRunning
		)
			throw new AppError("SESSION_BUSY", "会话正在运行，请确认停止并删除");
		this.catalog().beginDelete(userId, sessionId, revision);
		try {
			if (ctx) await this.close(sessionId, "user_close");
			const file = SessionManager.findById(row.workspace, sessionId, userSessionsDir(userId));
			if (file) rmSync(file, { force: true });
			this.runtimes().remove(userId, sessionId);
			this.runtimes().forgetActions(userId, sessionId);
			this.runtimes().forgetSettings(userId, sessionId);
			this.catalog().finishDelete(userId, sessionId);
		} catch (error) {
			this.catalog().failDelete(
				userId,
				sessionId,
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}

	startJanitor(): void {
		if (this.janitorTimer || this.stopped) return;
		this.janitorTimer = setInterval(() => {
			const idleMs = env.idleGcMinutes * 60_000;
			const now = Date.now();
			for (const ctx of this.map.values()) {
				const queue = queueSnapshot(ctx);
				if (
					!ctx.closing &&
					!ctx.recovery?.issue &&
					!ctx.recovery?.running &&
					ctx.session.isIdle &&
					!ctx.session.isBashRunning &&
					(ctx.status === "idle" || ctx.status === "error") &&
					ctx.approvals.pendingList().length === 0 &&
					queue.steering.length === 0 &&
					queue.followUp.length === 0 &&
					now - ctx.lastActiveAt > idleMs
				) {
					console.log(`[janitor] 回收空闲会话 ${ctx.sessionId}`);
					void this.close(ctx.sessionId, "idle_gc").catch(console.error);
				}
			}
		}, env.janitorIntervalSec * 1000);
	}

	async recoverPersisted(users: Array<{ userId: string; username: string }>): Promise<void> {
		for (const user of users) {
			this.reconcileUser(user.userId);
			for (const row of this.catalog().deleting(user.userId)) {
				try {
					await this.deleteSession(user.userId, row.sessionId, 0, true);
				} catch (error) {
					console.error("[delete recovery]", error);
				}
			}
		}
		for (const row of this.runtimes().list()) {
			const user = users.find((item) => item.userId === row.userId);
			if (!user) continue;
			try {
				const saved = this.runtimes().read(user.userId, row.sessionId)!;
				const cwd = resolveWorkspaceB64(user.userId, encodePath(saved.cwd));
				await this.create(user, cwd, row.sessionId);
			} catch (error) {
				console.error(`[recovery ${row.sessionId}]`, error);
			}
		}
	}

	async stop(options?: { preserveRunning?: boolean }): Promise<void> {
		this.stopped = true;
		if (this.janitorTimer) clearInterval(this.janitorTimer);
		await Promise.allSettled(this.starting);
		if (options?.preserveRunning) {
			const contexts = [...this.map.values()];
			for (const ctx of contexts) {
				ctx.closing = true;
				ctx.ui?.dispose();
				ctx.recovery?.suspend();
			}
			await Promise.all(contexts.map((ctx) => ctx.session.settingsManager.flush()));
			this.map.clear();
		} else
			await Promise.all([...this.map.values()].map((ctx) => this.close(ctx.sessionId, "shutdown")));
		this.runtimeStore?.close();
		this.runtimeStore = undefined;
		this.sessionCatalog?.close();
		this.sessionCatalog = undefined;
	}
}

/** 全局单例（进程内唯一注册表） */
export const registry = new SessionRegistry();
