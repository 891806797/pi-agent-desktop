/**
 * REST 客户端 —— 聊天页所有请求统一注入 x-session-id + x-workspace-dir（§5.10）。
 * 坐标从 URL query 读取，组件层不手工传。
 */

import type {
	ApiResult,
	CatalogSession,
	CatalogSnapshot,
	CommandsResponse,
	CreateSessionResponse,
	DefaultSettings,
	FileItem,
	HistoryResponse,
	LoginResponse,
	ModelRef,
	RunMode,
	SendMessageResponse,
	SessionInfoResponse,
	SessionSummary,
	ThinkingLevel,
	UpdateDefaultSettingsInput,
	WorkspaceInfo,
} from "@pi-agent/common";
import type { SendMessageInput } from "@pi-agent/common/dto/requests";
import { useAuthStore } from "@/stores/auth";

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

const pendingReads = new Map<string, Promise<unknown>>();
/** 只合并在途元数据读取；完成即移除，实时历史/目录不用共享旧快照。 */
function sharedRead<T>(path: string): Promise<T> {
	const key = JSON.stringify([useAuthStore.getState().username, path]);
	const current = pendingReads.get(key);
	if (current) return current as Promise<T>;
	const operation = request<T>(path).finally(() => {
		if (pendingReads.get(key) === operation) pendingReads.delete(key);
	});
	pendingReads.set(key, operation);
	return operation;
}

async function request<T>(
	path: string,
	init?: RequestInit & { headers?: Record<string, string> },
): Promise<T> {
	const mutating = !!init?.method && init.method !== "GET";
	if (mutating) pendingReads.clear();
	try {
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
	} finally {
		// 写期间启动的读取也可能是旧快照，保存完成后的读取必须重新发起。
		if (mutating) pendingReads.clear();
	}
}

// ===== auth =====

export const login = (username: string, password: string) =>
	request<LoginResponse>("/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ username, password }),
	});
export const logout = () => request("/api/auth/logout", { method: "POST" });
export const me = () => sharedRead<LoginResponse>("/api/auth/me");

export const getDefaultSettings = () => sharedRead<DefaultSettings>("/api/settings/defaults");
export const updateDefaultSettings = (patch: UpdateDefaultSettingsInput) =>
	request<DefaultSettings>("/api/settings/defaults", {
		method: "PATCH",
		body: JSON.stringify(patch),
	});

// ===== system =====

export const listWorkspaces = () => sharedRead<{ workspaces: WorkspaceInfo[] }>("/api/workspaces");
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
export const listModels = () => sharedRead<{ models: ModelRef[] }>("/api/models");
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

export function listCatalog(
	query: {
		workspace?: string;
		q?: string;
		archived?: boolean;
		cursor?: string;
		limit?: number;
	} = {},
) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query))
		if (value !== undefined && value !== "") params.set(key, String(value));
	return request<CatalogSnapshot>(`/api/sessions?${params}`);
}
export const updateSession = (
	sessionId: string,
	expectedRevision: number,
	patch: { name?: string; archived?: boolean },
) =>
	request<CatalogSession>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: "PATCH",
		body: JSON.stringify({ ...patch, expectedRevision }),
	});
export const deleteSession = (
	sessionId: string,
	expectedRevision: number,
	stopIfRunning: boolean,
) =>
	request<{ deleted: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
		body: JSON.stringify({ expectedRevision, stopIfRunning }),
	});
export const readSession = (sessionId: string, noticeVersion: number) =>
	request(`/api/sessions/${encodeURIComponent(sessionId)}/read`, {
		method: "POST",
		body: JSON.stringify({ noticeVersion }),
	});
export const recoverRun = (
	input: import("@pi-agent/common").RecoveryActionInput,
	coords: SessionCoordinates,
) =>
	request<{ accepted: true }>("/api/session/recovery", {
		method: "POST",
		headers: headersFor(coords),
		body: JSON.stringify(input),
	});
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
	request(`/api/session/approvals/${encodeURIComponent(requestId)}`, {
		method: "POST",
		headers: sessionHeaders(),
		body: JSON.stringify({ action, data }),
	});

// ===== 动态切换 =====

export const setModel = (provider: string, modelId: string, coords?: SessionCoordinates) =>
	request("/api/session/model", {
		method: "PUT",
		headers: headersFor(coords),
		body: JSON.stringify({ provider, modelId }),
	});
export const setThinking = (level: ThinkingLevel, coords?: SessionCoordinates) =>
	request("/api/session/thinking", {
		method: "PUT",
		headers: headersFor(coords),
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

export const getSettingsModels = () => sharedRead<{ models: unknown }>("/api/settings/models");
export const putSettingsModels = (models: unknown) =>
	request("/api/settings/models", { method: "PUT", body: JSON.stringify(models) });
