/**
 * agent 路由 —— 会话生命周期 / 消息 / 队列 / 审批 / 动态切换。
 * 会话操作坐标：header x-session-id + x-workspace-dir（base64url，§5.10）。
 */

import {
	ApprovalActionInput,
	CreateSessionInput,
	ListSessionsQuery,
	ModelSettingsInput,
	QueueDispatchInput,
	QueueRemoveInput,
	SendMessageInput,
	SessionHeaders,
	SetModelInput,
	SetRunModeInput,
	SetThinkingInput,
} from "@pi-agent/common/dto/requests";
import { Elysia } from "elysia";
import { ok } from "@/core/response";
import { vh } from "@/core/validate";
import {
	abortRun,
	clearQueue,
	closeSession,
	commands,
	getHistory,
	listSessions,
	openSession,
	removeQueueItem,
	requireCtx,
	sendMessage,
	sessionInfo,
	setModel,
	setRunMode,
	setThinking,
	settleApproval,
} from "@/modules/agent/agent.service";
import { getModelSettings, listModels, saveModelSettings } from "@/modules/agent/model.service";
import { dispatchQueuedMessage } from "@/modules/agent/queue-operations";
import { requireUser } from "@/modules/auth/auth.service";
import { authContext } from "./auth.middleware";

export const agentRoutes = new Elysia({ prefix: "/api" })
	.use(authContext)
	.get("/models", async ({ user }) => {
		const u = requireUser(user);
		return ok({ models: await listModels(u.userId) });
	})
	.get("/settings/models", ({ user }) => {
		const u = requireUser(user);
		return ok({ models: getModelSettings(u.userId) });
	})
	.put("/settings/models", async ({ body, user }) => {
		const u = requireUser(user);
		await saveModelSettings(u.userId, vh(ModelSettingsInput, body));
		return ok({ saved: true });
	})
	// ===== 会话生命周期 =====
	.post("/sessions", async ({ body, user }) => {
		const u = requireUser(user);
		const input = vh(CreateSessionInput, body);
		const result = await openSession(u, input.workspace, input.resumeSessionId);
		return ok(result);
	})
	.get("/sessions", ({ query, user }) => {
		const u = requireUser(user);
		const input = vh(ListSessionsQuery, query);
		return ok({ sessions: listSessions(u, input.workspace) });
	})
	.get("/session/info", ({ headers, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		const ctx = requireCtx(u, h["x-session-id"], h["x-workspace-dir"]);
		return ok(sessionInfo(ctx));
	})
	.get("/session/messages", ({ headers, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		const ctx = requireCtx(u, h["x-session-id"], h["x-workspace-dir"]);
		return ok(getHistory(ctx));
	})
	.post("/session/close", async ({ headers, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		await closeSession(u, h["x-session-id"], h["x-workspace-dir"]);
		return ok({ closed: true });
	})

	// ===== 消息与队列 =====
	.post("/session/messages", async ({ headers, body, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		const input = vh(SendMessageInput, body);
		const ctx = requireCtx(u, h["x-session-id"], h["x-workspace-dir"]);
		return ok(await sendMessage(ctx, input));
	})
	.post("/session/abort", async ({ headers, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		await abortRun(requireCtx(u, h["x-session-id"], h["x-workspace-dir"]));
		return ok({ aborted: true });
	})
	.post("/session/queue/clear", async ({ headers, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		await clearQueue(requireCtx(u, h["x-session-id"], h["x-workspace-dir"]));
		return ok({ cleared: true });
	})
	.post("/session/queue/remove", async ({ headers, body, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		const input = vh(QueueRemoveInput, body);
		await removeQueueItem(
			requireCtx(u, h["x-session-id"], h["x-workspace-dir"]),
			input.index,
			input.behavior,
			input.targetBehavior,
			input.expectedText,
			input.revision,
		);
		return ok({ removed: true });
	})
	.post("/session/queue/dispatch", async ({ headers, body, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		await dispatchQueuedMessage(
			requireCtx(u, h["x-session-id"], h["x-workspace-dir"]),
			vh(QueueDispatchInput, body),
		);
		return ok({ dispatched: true });
	})

	// ===== 审批（任一 tab settle → 总线广播 → 全页消失） =====
	.post("/session/approvals/:requestId", ({ headers, params, body, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		const input = vh(ApprovalActionInput, body);
		const ctx = requireCtx(u, h["x-session-id"], h["x-workspace-dir"]);
		settleApproval(ctx, params.requestId, input);
		return ok({ settled: true });
	})

	// ===== 动态切换 =====
	.put("/session/model", async ({ headers, body, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		const input = vh(SetModelInput, body);
		const ctx = requireCtx(u, h["x-session-id"], h["x-workspace-dir"]);
		await setModel(u, ctx, input.provider, input.modelId);
		return ok({ changed: true });
	})
	.put("/session/thinking", async ({ headers, body, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		const input = vh(SetThinkingInput, body);
		await setThinking(requireCtx(u, h["x-session-id"], h["x-workspace-dir"]), input.level);
		return ok({ changed: true });
	})
	.put("/session/run-mode", ({ headers, body, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		const input = vh(SetRunModeInput, body);
		setRunMode(requireCtx(u, h["x-session-id"], h["x-workspace-dir"]), input.mode);
		return ok({ changed: true });
	})

	// ===== `/` 命令列表 =====
	.get("/session/commands", ({ headers, user }) => {
		const u = requireUser(user);
		const h = vh(SessionHeaders, headers);
		return ok(commands(requireCtx(u, h["x-session-id"], h["x-workspace-dir"])));
	});
