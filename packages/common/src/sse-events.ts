/**
 * SSE 事件协议 —— 事件总线 wire protocol 单一事实源。
 *
 * 按 pi-coding-agent 实际事件定义 Web 协议：
 * - 新增 queue_update / thinking_level_changed / model_changed / session_name（pi 原生语义）
 * - 新增 tool_result_partial（tool_execution_update.partialResult，工具流式输出）
 * - 新增 user_bash_output（bash_execution_update，用户 !cmd，与工具调用独立）
 * - 新增 retry（auto_retry_start/end，重试≠错误）
 * - compaction 携带 summary/tokens（compaction_end.result）
 * - usage 携带 reasoning/stopReason/durationMs/responseModel
 * - 只投影本项目已接入的运行事件，组件不推断外部框架协议
 *
 * 所有非审批事件经会话事件总线定序后下发（seq 单调递增 + 500 条环形缓冲），
 * 前端以 seq 幂等 + 跳洞对账保证多 tab 镜像一致（见实施计划 §4）。
 */

import type {
	AgentStatus,
	PendingRequest,
	RunMode,
	SessionCloseReason,
	SessionMetrics,
	SlashCommand,
	SSEEventUsageData,
	ThinkingLevel,
} from "./messages";

export type { AgentStatus, RunMode, SessionCloseReason, ThinkingLevel };

// ===== 事件 =====

export interface SSEEventSession {
	event: "session";
	data: { sessionId: string };
}

export interface SSEEventCommands {
	event: "commands";
	data: { commands: SlashCommand[] };
}

export interface SSEEventStatus {
	event: "status";
	data: { status: AgentStatus; newRun?: boolean };
}

export interface SSEEventMessageStart {
	event: "message_start";
	data: { messageId: string };
}

export interface SSEEventTextChunk {
	event: "text_chunk";
	data: { messageId: string; delta: string };
}

export interface SSEEventThinkingChunk {
	event: "thinking_chunk";
	data: { messageId: string; delta: string };
}

export interface SSEEventToolCallStart {
	event: "tool_call_start";
	data: { toolCallId: string; name: string; messageId: string; parentToolCallId?: string };
}

/** 工具参数流（toolcall_delta，args JSON 增量） */
export interface SSEEventToolCallArgs {
	event: "tool_call_args";
	data: { toolCallId: string; delta: string };
}

export interface SSEEventToolCallEnd {
	event: "tool_call_end";
	data: { toolCallId: string; argsText?: string };
}

export interface SSEEventToolResult {
	event: "tool_result";
	data: {
		toolCallId: string;
		content: string;
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		error?: boolean;
		toolUseResult?: unknown;
		durationMs?: number;
	};
}

/** 工具执行中的部分结果（tool_execution_update.partialResult）—— bash 实时 stdout / 长任务进度 */
export interface SSEEventToolResultPartial {
	event: "tool_result_partial";
	data: {
		toolCallId: string;
		content: string;
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		details?: unknown;
		isError?: boolean;
	};
}

/** 用户 !cmd bash 输出（bash_execution_update，与工具调用独立） */
export interface SSEEventUserBashOutput {
	event: "user_bash_output";
	data: { id?: string; delta: string };
}

export interface SSEEventUserMessage {
	event: "user_message";
	data: { uuid: string; content: string; images?: import("./messages").ToolResultInfo["images"] };
}

export interface SSEEventMessageEnd {
	event: "message_end";
	data: { messageId: string; stopReason?: string; errorMessage?: string };
}

export interface SSEEventUsage {
	event: "usage";
	data: SSEEventUsageData;
}

export interface SSEEventApprovalRequest {
	event: "approval_request";
	/** 不带 seq 随订阅首帧重放，前端按 requestId 幂等 */
	data: PendingRequest;
}

export interface SSEEventApprovalSettled {
	event: "approval_settled";
	data: {
		requestId: string;
		outcome: "allow" | "deny" | "answer" | "cancelled";
		reason?: string;
	};
}

export interface SSEEventQueueUpdate {
	event: "queue_update";
	data: { steering: string[]; followUp: string[]; revision?: number };
}

export interface SSEEventThinkingLevelChanged {
	event: "thinking_level_changed";
	data: { level: ThinkingLevel };
}

export interface SSEEventModelChanged {
	event: "model_changed";
	data: { provider: string; modelId: string; availableThinkingLevels?: ThinkingLevel[] };
}

export interface SSEEventRunMode {
	event: "run_mode";
	data: { mode: RunMode };
}

/** compaction（压缩）：start/end + summary/tokens（end 时来自 CompactionResult） */
export interface SSEEventCompaction {
	event: "compaction";
	data: {
		phase: "start" | "end";
		id?: string;
		createdAt?: number;
		outcome?: "success" | "cancelled" | "error";
		errorMessage?: string;
		trigger?: "manual" | "threshold" | "overflow";
		summary?: string;
		tokensBefore?: number;
		tokensAfter?: number;
	};
}

export interface SSEEventSessionName {
	event: "session_name";
	data: { name: string | undefined };
}

/** provider 请求级自动重试（auto_retry_start/end），重试中≠错误 */
export interface SSEEventRetry {
	event: "retry";
	data: {
		phase: "start" | "end";
		attempt: number;
		maxAttempts?: number;
		delayMs?: number;
		message?: string;
		success?: boolean;
	};
}

export interface SSEEventError {
	event: "error";
	data: { message: string };
}

export interface SSEEventTurnEnd {
	event: "turn_end";
	data: { partial: boolean };
}

export interface SSEEventQueryClosed {
	event: "query_closed";
	data: { reason: SessionCloseReason };
}

export type SSEEvent =
	| { event: "heartbeat"; data: { seq: number } }
	| { event: "session_metrics"; data: SessionMetrics }
	| { event: "system_message"; data: { id: string; content: string; createdAt: number } }
	| SSEEventSession
	| SSEEventCommands
	| SSEEventStatus
	| SSEEventMessageStart
	| SSEEventTextChunk
	| SSEEventThinkingChunk
	| SSEEventToolCallStart
	| SSEEventToolCallArgs
	| SSEEventToolCallEnd
	| SSEEventToolResult
	| SSEEventToolResultPartial
	| SSEEventUserBashOutput
	| SSEEventUserMessage
	| SSEEventMessageEnd
	| SSEEventUsage
	| SSEEventApprovalRequest
	| SSEEventApprovalSettled
	| SSEEventQueueUpdate
	| SSEEventThinkingLevelChanged
	| SSEEventModelChanged
	| SSEEventRunMode
	| SSEEventCompaction
	| SSEEventSessionName
	| SSEEventRetry
	| SSEEventError
	| SSEEventTurnEnd
	| SSEEventQueryClosed;

/** 经事件总线定序后的事件（挂起审批重放除外，不带 seq） */
export type SequencedEvent = { seq: number } & SSEEvent;

/**
 * 重同步信号：环形缓冲跳洞时服务端下发 error 事件携带此消息后断流，
 * 前端收到后拉 GET /history 全量对账并以新 seq 锚点重连。
 */
export const RESYNC_MESSAGE = "__resync__";
