/**
 * agent service —— 会话业务逻辑（route 层只做入参校验 → service → ok）。
 * 不 import elysia；失败一律 raise AppError。
 */

import type {
	ApprovalActionInput,
	HistoryResponse,
	PendingRequest,
	RecoveryActionInput,
	SendMessageInput,
	SessionInfoResponse,
	ThinkingLevel,
} from "@pi-agent/common";
import { EXTENSION_UI_LIMITS, utf8Length } from "@pi-agent/common";
import { z } from "zod";
import { AppError } from "@/core/app-error";
import type { AuthUser } from "@/modules/auth/token";
import { expandFileReferences } from "@/modules/system/file-references";
import { resolveWorkspaceB64 } from "@/modules/system/workspace-registry";
import type { ApprovalManager } from "./approval-manager";
import { listCommands } from "./commands";
import { projectMessages } from "./history";
import { configuredDefaultThinking, configuredModels } from "./model-config";
import {
	captureQueuedImages,
	clearSessionQueue,
	editSessionQueue,
	queueSnapshot,
	queueTransaction,
} from "./queue-operations";
import { readSessionMetrics } from "./session-metrics";
import { registry, type SessionContext } from "./session-registry";

/** 校验属主并取活跃 ctx；未命中抛 404（前端据此走 resume 链路） */
export function requireCtx(
	user: AuthUser,
	sessionId: string,
	workspaceB64?: string,
): SessionContext {
	const cwd =
		workspaceB64 !== undefined ? resolveWorkspaceB64(user.userId, workspaceB64) : undefined;
	const ctx = registry.get(sessionId, user.userId, cwd);
	if (!ctx) throw new AppError("NOT_FOUND", "会话不存在或未激活");
	if (ctx.closing) throw new AppError("SESSION_BUSY", "会话正在关闭");
	return ctx;
}

export async function openSession(
	user: AuthUser,
	workspaceB64: string,
	resumeSessionId?: string,
): Promise<{ sessionId: string; live: boolean }> {
	const cwd = resolveWorkspaceB64(user.userId, workspaceB64);
	await registry.invalidateModelRuntime(user.userId);
	if (resumeSessionId) {
		const existing = registry.get(resumeSessionId, user.userId, cwd);
		if (existing) {
			const runtime = await registry.modelRuntimeFor(user.userId);
			const models = configuredModels(user.userId, runtime);
			const current = existing.session.model;
			const selected =
				models.find((model) => model.provider === current?.provider && model.id === current.id) ??
				models[0];
			if (selected && JSON.stringify(selected) !== JSON.stringify(current))
				await setModel(user, existing, selected.provider, selected.id);
			return { sessionId: existing.sessionId, live: true };
		}
	}
	const ctx = await registry.create(user, cwd, resumeSessionId);
	return { sessionId: ctx.sessionId, live: true };
}

export async function recoverSession(
	user: AuthUser,
	sessionId: string,
	workspaceB64: string,
	input: RecoveryActionInput,
) {
	const cwd = resolveWorkspaceB64(user.userId, workspaceB64);
	registry.catalog().assertAvailable(user.userId, sessionId);
	const ctx =
		registry.get(sessionId, user.userId, cwd) ?? (await registry.create(user, cwd, sessionId));
	return queueTransaction(ctx, async () => {
		registry.catalog().assertAvailable(user.userId, sessionId);
		if (!ctx.recovery) throw new AppError("AGENT_ERROR", "恢复状态不可用");
		return ctx.recovery.applyAction(input);
	});
}

export function listSessions(user: AuthUser, workspaceB64?: string) {
	return registry.listSessions(
		user.userId,
		workspaceB64 ? resolveWorkspaceB64(user.userId, workspaceB64) : undefined,
	);
}

export function healthInfo() {
	return { status: "ok", sessions: registry.liveCount() };
}

export function getHistory(ctx: SessionContext): HistoryResponse {
	// SDK state 包含已完成消息及当前 partial；不能用只有已落盘消息的快照配最新 seq。
	const messages = [...ctx.session.messages];
	const partial = ctx.session.state.streamingMessage;
	if (partial && !messages.includes(partial)) messages.push(partial);
	return {
		...sessionInfo(ctx),
		messages: ctx.translator.decorateMessages(
			projectMessages(messages, (message) => ctx.translator.messageId(message)),
		),
		seq: ctx.bus.currentSeq,
		epoch: ctx.bus.epoch,
	};
}

export function sessionInfo(ctx: SessionContext): SessionInfoResponse {
	const model = ctx.session.model;
	return {
		sessionId: ctx.sessionId,
		workspace: ctx.cwd,
		status: ctx.approvals.pendingList().length ? "awaiting-approval" : ctx.status,
		isCompacting: ctx.session.isCompacting,
		model: model ? { provider: model.provider, modelId: model.id, name: model.name } : null,
		thinkingLevel: ctx.session.thinkingLevel,
		availableThinkingLevels: ctx.session.getAvailableThinkingLevels(),
		runMode: ctx.runMode.mode,
		queue: queueSnapshot(ctx),
		pendingApprovals: ctx.approvals.pendingList(),
		metrics: readSessionMetrics(ctx.session),
		issue: ctx.recovery?.issue ?? null,
		ui: ctx.ui?.snapshot,
	};
}

export async function sendMessage(
	ctx: SessionContext,
	input: SendMessageInput,
): Promise<{ queued: boolean }> {
	// 压缩不会修改输入队列；等待整段压缩会挡住 abort，故不占用队列事务。
	if (/^\/compact(?:\s|$)/.test(input.text)) return sendMessageUnlocked(ctx, input);
	return queueTransaction(ctx, () => sendMessageUnlocked(ctx, input));
}

async function sendMessageUnlocked(
	ctx: SessionContext,
	input: SendMessageInput,
): Promise<{ queued: boolean }> {
	if (ctx.closing) throw new AppError("SESSION_BUSY", "会话正在关闭");
	if (ctx.session.isCompacting) throw new AppError("SESSION_BUSY", "正在压缩上下文，请稍后发送");
	if (/^\/compact(?:\s|$)/.test(input.text)) {
		if (!ctx.session.isIdle) throw new AppError("SESSION_BUSY", "请等待当前运行结束后压缩");
		await ctx.session.compact(input.text.slice(8).trim() || undefined);
		return { queued: false };
	}
	if (/^\/clear(?:\s|$)/.test(input.text))
		throw new AppError("BAD_REQUEST", "请使用新建会话按钮开始新对话");
	const { text: expanded, images } = expandFileReferences(input.text, ctx.cwd);
	const allImages = [...images, ...(input.images ?? [])];
	const inputId = ctx.recovery?.beginInput(expanded, allImages, input.behavior ?? "followUp");
	// preflightResult 表示 SDK 实际已开始/入队，既不提前报告成功，也不等整个模型运行结束。
	return captureQueuedImages(
		ctx,
		allImages,
		() =>
			new Promise((resolve, reject) => {
				let accepted = false;
				const accept = (disposition: string) => {
					if (inputId) ctx.recovery?.acceptInput(inputId, disposition);
					accepted = true;
					resolve({ queued: disposition === "queued" });
				};
				const operation =
					ctx.recovery?.running || ctx.recovery?.blocked
						? ctx.session[input.behavior === "steer" ? "steer" : "followUp"](expanded, allImages, {
								source: "rpc",
							}).then(accept)
						: ctx.session.prompt(expanded, {
								streamingBehavior: input.behavior ?? "followUp",
								source: "rpc",
								...(allImages.length ? { images: allImages } : {}),
								preflightResult: accept,
							});
				void operation
					.then(() => {
						if (!accepted) {
							if (inputId) ctx.recovery?.rejectInput(inputId);
							resolve({ queued: false });
						}
					})
					.catch((err: unknown) => {
						const message = err instanceof Error ? err.message : "消息发送失败";
						if (!accepted) {
							if (inputId) ctx.recovery?.rejectInput(inputId);
							reject(new AppError("AGENT_ERROR", message));
						} else ctx.bus.publish({ event: "error", data: { message } });
					});
			}),
		inputId,
	);
}

export async function abortRun(ctx: SessionContext): Promise<void> {
	await queueTransaction(ctx, async () => {
		ctx.interrupted = true;
		ctx.recovery?.cancel();
		clearSessionQueue(ctx);
		ctx.approvals.rejectAll("运行已中止");
		await ctx.session.abort();
		await ctx.recovery?.wait();
	});
}

/** 审批终结：settled 幂等已由 ApprovalManager 保证；此处只在 miss 时 404 */
export function settleApproval(
	ctx: SessionContext,
	requestId: string,
	input: ApprovalActionInput,
): void {
	const settled = doSettle(ctx.approvals, requestId, input);
	if (!settled) throw new AppError("NOT_FOUND", "审批不存在或已处理");
}

function doSettle(
	approvals: ApprovalManager,
	requestId: string,
	input: ApprovalActionInput,
): boolean {
	const request = approvals.get(requestId);
	if (!request) return false;
	const invalid = () => {
		throw new AppError("BAD_REQUEST", "审批动作或答案与当前问题不匹配");
	};
	if (input.action === "answer") {
		if (request.kind === "tool_permission") invalid();
		if (request.kind === "ui_confirm" && typeof input.data !== "boolean") invalid();
		if (
			(request.kind === "ui_input" ||
				request.kind === "ui_select" ||
				request.kind === "ui_editor") &&
			typeof input.data !== "string"
		)
			invalid();
		if (
			request.kind === "ui_editor" &&
			utf8Length(input.data as string) > EXTENSION_UI_LIMITS.editorBytes
		)
			invalid();
		if (
			request.kind === "ui_select" &&
			!(request.payload as { options: string[] }).options.includes(input.data as string)
		)
			invalid();
		if (request.kind === "ask_question") {
			const parsed = z
				.object({
					answers: z.record(z.string(), z.string()),
					annotations: z.record(z.string(), z.object({ notes: z.string().optional() })).optional(),
				})
				.safeParse(input.data);
			if (!parsed.success) return invalid();
			const questions = (request.payload as { questions: import("@pi-agent/common").AskQuestion[] })
				.questions;
			for (const question of questions) {
				const answer = parsed.data.answers[question.question]?.trim();
				if (question.required !== false && !answer) invalid();
				if (
					answer &&
					question.allowCustom === false &&
					!question.multiSelect &&
					!question.options.some((option) => option.label === answer)
				)
					invalid();
			}
			input = { ...input, data: parsed.data };
		}
	} else if (
		input.action === "allow" &&
		request.kind !== "tool_permission" &&
		request.kind !== "ui_confirm"
	)
		invalid();
	switch (input.action) {
		case "allow":
			return approvals.settle(requestId, { action: "allow", data: { allowed: true } });
		case "deny":
			return approvals.settle(requestId, {
				action: "deny",
				data: { allowed: false },
				reason: "用户拒绝了本次操作",
			});
		case "answer":
			return approvals.settle(requestId, { action: "answer", data: input.data });
		case "cancel":
			// 协议事件 outcome 用 'cancelled'（ApprovalOutcome），入参动作用 'cancel'
			return approvals.settle(requestId, { action: "cancelled", reason: "用户取消" });
	}
}

function changeModelSettings(
	ctx: SessionContext,
	change: () => void | Promise<void>,
): Promise<void> {
	// 复用会话变更事务：思考档位按新模型应用，关闭也等待 SDK 的最后一次配置写入。
	return queueTransaction(ctx, async () => {
		if (ctx.closing) throw new AppError("SESSION_BUSY", "会话正在关闭");
		await change();
	});
}

export async function setModel(
	user: AuthUser,
	ctx: SessionContext,
	provider: string,
	modelId: string,
): Promise<void> {
	await changeModelSettings(ctx, async () => {
		const runtime = await registry.modelRuntimeFor(user.userId);
		const model = configuredModels(user.userId, runtime).find(
			(model) => model.provider === provider && model.id === modelId,
		);
		if (!model) throw new AppError("MODEL_NOT_FOUND", `${provider}/${modelId} 不存在或未配置认证`);
		if (ctx.closing) throw new AppError("SESSION_BUSY", "会话正在关闭");
		const changed = ctx.session.model?.provider !== provider || ctx.session.model?.id !== modelId;
		await ctx.session.setModel(model);
		if (changed)
			ctx.session.setThinkingLevel(configuredDefaultThinking(user.userId, provider, modelId));
		ctx.bus.publish({
			event: "model_changed",
			data: {
				provider,
				modelId,
				availableThinkingLevels: ctx.session.getAvailableThinkingLevels(),
			},
		});
		ctx.persistSettings?.();
	});
}

export function setThinking(ctx: SessionContext, level: ThinkingLevel): Promise<void> {
	return changeModelSettings(ctx, () => {
		ctx.session.setThinkingLevel(level);
		ctx.persistSettings?.();
		// SDK 广播按模型能力调整后的实际值，不再用请求值覆盖。
	});
}

export function setRunMode(ctx: SessionContext, mode: "auto" | "standard" | "safe" | "plan"): void {
	// holder.onChange 自动广播 run_mode 事件
	ctx.runMode.set(mode);
	ctx.persistSettings?.();
}

export function clearQueue(ctx: SessionContext): Promise<void> {
	return queueTransaction(ctx, async () => {
		ctx.recovery?.clearQueuedInputs();
		clearSessionQueue(ctx);
	});
}

/** SDK 无单条编辑接口，通过每会话事务保留两轨条目及附件。 */
export function removeQueueItem(
	ctx: SessionContext,
	index: number,
	behavior: "steer" | "followUp",
	targetBehavior?: "steer" | "followUp",
	expectedText?: string,
	revision?: number,
): Promise<void> {
	return queueTransaction(ctx, () =>
		editSessionQueue(ctx, index, behavior, targetBehavior, expectedText, false, revision),
	);
}

export function commands(ctx: SessionContext): { commands: ReturnType<typeof listCommands> } {
	return { commands: listCommands(ctx) };
}

export async function closeSession(
	user: AuthUser,
	sessionId: string,
	workspaceB64?: string,
): Promise<void> {
	// 非属主也直接静默成功（不泄露存在性）
	const ctx = registry.get(
		sessionId,
		user.userId,
		workspaceB64 ? resolveWorkspaceB64(user.userId, workspaceB64) : undefined,
	);
	if (ctx) await registry.close(sessionId, "user_close");
}

export function pendingApprovals(ctx: SessionContext): PendingRequest[] {
	return ctx.approvals.pendingList();
}
