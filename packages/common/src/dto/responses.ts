/**
 * REST 响应体 —— 纯 TS 接口（与 requests.ts 的 zod 单源对偶）。
 * 所有成功响应包 { ok: true, data }；失败统一 { ok: false, code, message }（见 backend core/response.ts）。
 */

import type {
	AgentStatus,
	AskQuestionPayload,
	ChatMessage,
	ModelRef,
	PendingRequest,
	RunMode,
	SessionMetrics,
	SessionSummary,
	SlashCommand,
	ThinkingLevel,
	ToolPermissionPayload,
	UiConfirmPayload,
	UiInputPayload,
	UiSelectPayload,
} from "../messages";

export interface Ok<T> {
	ok: true;
	data: T;
}

export interface Err {
	ok: false;
	code: string;
	message: string;
}

export type ApiResult<T> = Ok<T> | Err;

// ===== auth =====

export interface LoginResponse {
	username: string;
}

// ===== system =====

export interface WorkspaceInfo {
	/** 工作空间绝对路径明文 */
	path: string;
	/** base64url（回填 URL query 用） */
	encoded: string;
	name: string;
}

export interface ModelListResponse {
	models: ModelRef[];
}

// ===== agent：会话 =====

export interface CreateSessionResponse {
	sessionId: string;
	/** 会话是否为活跃 in-process 实例（resume 时 attach 已存在则 true） */
	live: boolean;
}

export interface SessionListResponse {
	sessions: SessionSummary[];
}

export interface SessionInfoResponse {
	ui?: import("../extension-ui").ExtensionUISnapshot;
	issue?: import("../run-issue").RunIssue | null;
	sessionId: string;
	workspace: string;
	status: AgentStatus;
	isCompacting: boolean;
	model: ModelRef | null;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	runMode: RunMode;
	queue: { steering: string[]; followUp: string[]; revision?: number };
	pendingApprovals: PendingRequest[];
	metrics: SessionMetrics;
}

export interface HistoryResponse extends SessionInfoResponse {
	epoch?: string;
	messages: ChatMessage[];
	/** 当前事件总线 seq，作为 SSE 增量重放锚点 */
	seq: number;
}

// ===== agent：消息 =====

export interface SendMessageResponse {
	/** true = 运行中已排队（steer/followUp），false = 已直接提交 */
	queued: boolean;
}

export interface CommandsResponse {
	commands: SlashCommand[];
}

export interface FileItem {
	/** 相对 workspace 的 posix 路径（@ 引用即用此） */
	path: string;
	name: string;
	isDir: boolean;
}

export interface FilesResponse {
	files: FileItem[];
}

// ===== 审批 payload 类型重导出（前端按 kind 收窄渲染卡片） =====

export type {
	AskQuestionPayload,
	ToolPermissionPayload,
	UiConfirmPayload,
	UiInputPayload,
	UiSelectPayload,
};

export interface FileContentResponse {
	content: string;
	revision: string;
}
