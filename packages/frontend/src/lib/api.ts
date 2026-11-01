/**
 * REST 客户端 —— 聊天页所有请求统一注入 x-session-id + x-workspace-dir（§5.10）。
 * 坐标从 URL query 读取，组件层不手工传。
 */

import type {
	ApiResult,
	CommandsResponse,
	CreateSessionResponse,
	FileItem,
	HistoryResponse,
	LoginResponse,
	ModelRef,
	RunMode,
	SendMessageResponse,
	SessionInfoResponse,
	SessionSummary,
	ThinkingLevel,
	WorkspaceInfo,
} from "@pi-agent/common";
import type { SendMessageInput } from "@pi-agent/common/dto/requests";

// ===== 会话坐标（Chat 页 URL query）=====

export function urlWorkspace(): string | null {
	return new URLSearchParams(location.search).get("workspace");
}
export function urlSessionId(): string | null {
	return new URLSearchParams(location.search).get("sessionId");
}

function sessionHeaders(
	sessionId = urlSessionId(),
	workspace = urlWorkspace(),
): Record<string, string> {
	if (!sessionId || !workspace) throw new Error("缺少会话坐标（workspace/sessionId）");
	return { "x-session-id": sessionId, "x-workspace-dir": workspace };
}

export class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}
export interface SessionCoordinates {
	sessionId: string;
	workspace: string;
}
const headersFor = (c?: SessionCoordinates) =>
	c ? sessionHeaders(c.sessionId, c.workspace) : sessionHeaders();
// ===== 底层封装 =====

async function request<T>(
	path: string,
	init?: RequestInit & { headers?: Record<string, string> },
): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		credentials: "same-origin",
	});
	const body = (await res.json().catch(() => null)) as ApiResult<T> | null;
	if (!body) throw new Error(`HTTP ${res.status}`);
	if (!body.ok) {
		if (res.status === 401 && !location.pathname.startsWith("/login")) {
			location.href = "/login";
		}
		throw new ApiError(res.status, body.code, body.message);
	}
	return body.data;
}

// ===== auth =====

export const login = (username: string, password: string) =>
	request<LoginResponse>("/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ username, password }),
	});
export const logout = () => request("/api/auth/logout", { method: "POST" });
export const me = () => request<LoginResponse>("/api/auth/me");

// ===== system =====

export const listWorkspaces = () => request<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
export const addWorkspace = (path: string) =>
	request<{ workspace: WorkspaceInfo }>("/api/workspaces", {
		method: "POST",
		body: JSON.stringify({ path }),
	});

/** 列目录（文件夹选择器用）：path 空返根（drives=主目录+盘符，entries 空） */
export const listDirs = (path?: string) =>
	request<{
		current: string;
		entries: Array<{ name: string; path: string }>;
		drives: string[];
	}>(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
export const listModels = () => request<{ models: ModelRef[] }>("/api/models");
export const listFiles = (dirB64: string, q?: string) =>
	request<{ files: FileItem[] }>(
		`/api/files?dir=${encodeURIComponent(dirB64)}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
	);

// ===== 会话 =====

export const createSession = (workspace: string, resumeSessionId?: string) =>
	request<CreateSessionResponse>("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ workspace, resumeSessionId }),
	});
export const listSessions = (workspaceB64?: string) =>
	request<{ sessions: SessionSummary[] }>(
		`/api/sessions${workspaceB64 ? `?workspace=${workspaceB64}` : ""}`,
	);
export const closeSession = () =>
	request("/api/session/close", { method: "POST", headers: sessionHeaders() });
export const sessionInfo = () =>
	request<SessionInfoResponse>("/api/session/info", { headers: sessionHeaders() });

// ===== 消息 / 队列 =====

export const history = (coords?: SessionCoordinates) =>
	request<HistoryResponse>("/api/session/messages", { headers: headersFor(coords) });
export const sendMessage = (input: SendMessageInput, coords?: SessionCoordinates) =>
	request<SendMessageResponse>("/api/session/messages", {
		method: "POST",
		headers: headersFor(coords),
		body: JSON.stringify(input),
	});
export const abortRun = () =>
	request("/api/session/abort", { method: "POST", headers: sessionHeaders() });
export const clearQueue = () =>
	request("/api/session/queue/clear", { method: "POST", headers: sessionHeaders() });
export const dispatchQueueItem = (
	input: import("@pi-agent/common/dto/requests").QueueDispatchInput,
) =>
	request("/api/session/queue/dispatch", {
		method: "POST",
		headers: sessionHeaders(),
		body: JSON.stringify(input),
	});
export const removeQueueItem = (
	index: number,
	behavior: "steer" | "followUp",
	expectedText?: string,
	targetBehavior?: "steer" | "followUp",
	revision?: number,
) =>
	request("/api/session/queue/remove", {
		method: "POST",
		headers: sessionHeaders(),
		body: JSON.stringify({ index, behavior, expectedText, targetBehavior, revision }),
	});

// ===== 审批 =====

export const settleApproval = (
	requestId: string,
	action: "allow" | "deny" | "answer" | "cancel",
	data?: unknown,
) =>
	request(`/api/session/approvals/${requestId}`, {
		method: "POST",
		headers: sessionHeaders(),
		body: JSON.stringify({ action, data }),
	});

// ===== 动态切换 =====

export const setModel = (provider: string, modelId: string) =>
	request("/api/session/model", {
		method: "PUT",
		headers: sessionHeaders(),
		body: JSON.stringify({ provider, modelId }),
	});
export const setThinking = (level: ThinkingLevel) =>
	request("/api/session/thinking", {
		method: "PUT",
		headers: sessionHeaders(),
		body: JSON.stringify({ level }),
	});
export const setRunMode = (mode: RunMode, coords?: SessionCoordinates) =>
	request("/api/session/run-mode", {
		method: "PUT",
		headers: headersFor(coords),
		body: JSON.stringify({ mode }),
	});

// ===== 命令 =====

export const commands = () =>
	request<CommandsResponse>("/api/session/commands", { headers: sessionHeaders() });

// ===== settings：provider 配置（models.json）=====

export const getSettingsModels = () => request<{ models: unknown }>("/api/settings/models");
export const putSettingsModels = (models: unknown) =>
	request("/api/settings/models", { method: "PUT", body: JSON.stringify(models) });
