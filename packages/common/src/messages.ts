/**
 * 前端渲染模型 —— SSE 累积与 history 快照共用同一形状。
 *
 * ChatMessage 由两条路径产生且必须同构：
 * 1. 前端 store 逐事件 applyEvent 累积（流式增量）
 * 2. 后端 history.ts 从 pi JSONL 投影（刷新/重连全量对账）
 *
 * 共享枚举（RunMode/ThinkingLevel/AgentStatus/SessionCloseReason）也定义于此，
 * sse-events.ts 只 import 不重复定义（避免循环）。
 */

// ===== 共享枚举 =====

export type RunMode = "auto" | "standard" | "safe" | "plan";

/** pi ThinkingLevel（@earendil-works/pi-agent-core），前后端仅作展示与传参用 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AgentStatus =
	| "idle"
	| "thinking"
	| "responding"
	| "tool-use"
	| "awaiting-approval"
	| "error";

/** 会话关闭原因 */
export type SessionCloseReason =
	| "user_close"
	| "idle_gc"
	| "life_limit"
	| "quota_evict"
	| "shutdown"
	| "error";

// ===== 斜杠命令 =====

export interface SlashCommand {
	name: string; // 不含 '/' 前缀；skill 源为 'skill:<name>'
	description?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
}

/** Web 已接入的 pi 命令，空白页与已创建会话使用同一份定义。 */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
	{ name: "new", description: "开始新会话，当前后台运行继续保留", source: "builtin" },
	{ name: "compact", description: "压缩当前会话上下文，可在命令后补充压缩要求", source: "builtin" },
];

// ===== 审批挂起请求 =====

export type PendingKind =
	| "tool_permission"
	| "ask_question"
	| "ui_select"
	| "ui_confirm"
	| "ui_input";

export interface ToolPermissionPayload {
	toolName: string;
	/** 工具调用参数（bash 命令 / write 路径等），前端按工具名渲染摘要 */
	input: Record<string, unknown>;
	runMode: RunMode;
}

export interface AskQuestionOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	question: string;
	options: AskQuestionOption[];
	multiSelect?: boolean;
	allowCustom?: boolean;
	notes?: string;
	required?: boolean;
}

export interface AskQuestionPayload {
	questions: AskQuestion[];
}

export interface UiSelectPayload {
	title: string;
	options: string[];
}

export interface UiConfirmPayload {
	title: string;
	message: string;
}

export interface UiInputPayload {
	title: string;
	placeholder?: string;
}

export type PendingPayload =
	| ToolPermissionPayload
	| AskQuestionPayload
	| UiSelectPayload
	| UiConfirmPayload
	| UiInputPayload;

/** 挂起审批（tool_permission 用 toolCallId，其余用 uuid） */
export interface PendingRequest {
	requestId: string;
	/** 服务端绝对截止时间（毫秒）；恢复页面沿用该值，不重新计时。 */
	expiresAt?: number;
	kind: PendingKind;
	payload: PendingPayload;
	createdAt: number;
}

// ===== 模型引用 =====

export interface ModelRef {
	provider: string;
	modelId: string;
	name?: string;
	contextWindow?: number;
	supportedThinkingLevels?: ThinkingLevel[];
}

// ===== 会话 =====

export interface SessionSummary {
	sessionId: string;
	/** 工作空间绝对路径明文（会话列表展示用，经后端校验后下发） */
	workspace: string;
	/** 首条用户消息摘要 */
	firstMessage: string;
	/** 是否有活跃 in-process 会话 */
	live: boolean;
	createdAt?: string;
	lastActiveAt?: string;
	name?: string;
}

// ===== 聊天消息 =====

export interface ToolResultInfo {
	content: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	error?: boolean;
	toolUseResult?: unknown;
	durationMs?: number;
}

export type AssistantBlock =
	| { kind: "text"; text: string }
	| { kind: "thinking"; thinking: string }
	| {
			kind: "toolCall";
			toolCallId: string;
			name: string;
			/** 参数 JSON 文本（流式累积，tool_call_end 时完成） */
			argsText: string;
			status: "streaming" | "running" | "done" | "error" | "cancelled";
			parentToolCallId?: string;
			result?: ToolResultInfo;
	  };

export type ChatMessage =
	| {
			id: string;
			type: "user";
			content: string;
			images?: ToolResultInfo["images"];
			createdAt: number;
	  }
	| {
			id: string;
			type: "assistant";
			blocks: AssistantBlock[];
			model?: string;
			usage?: SSEEventUsageData;
			stopReason?: string;
			errorMessage?: string;
			createdAt: number;
	  }
	| {
			id: string;
			type: "compaction";
			summary: string;
			tokensBefore?: number;
			tokensAfter?: number;
			trigger?: "manual" | "threshold" | "overflow";
			createdAt: number;
	  }
	| { id: string; type: "system"; content: string; createdAt: number };

export interface SSEEventUsageData {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	/** 推理 token（output 子集），缺失为 0 */
	reasoningTokens?: number;
	/** 该 assistant 消息的停止原因（length/error/toolUse/stop/...） */
	stopReason?: string;
	/** 单次响应耗时（ms） */
	durationMs?: number;
	/** 实际响应模型（与请求 model 不同时） */
	responseModel?: string;
}

/** 与 pi TUI footer 同口径：会话累计用量、最近响应缓存率和当前上下文估算。 */
export interface SessionMetrics
	extends Pick<
		SSEEventUsageData,
		"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"
	> {
	/** 最近一条 assistant 的 cacheRead / (input + cacheRead + cacheWrite)，百分比。 */
	cacheHitRate: number | null;
	/** 压缩后 tokens/percent 可为 null，待后续有效响应更新。 */
	contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
}
