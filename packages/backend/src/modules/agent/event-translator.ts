/**
 * 事件翻译层 —— AgentSessionEvent → SSEEvent（实施计划 §5.2，单测重点）。
 *
 * 有状态：维护 contentIndex → toolCallId 映射（toolcall_start 建，toolcall_end 清），
 * 因为 pi 的 toolcall_delta 在协议层不携带 toolCallId（json-event.ts 丢 partial）。
 * 靠尾部扫描在多并发 toolCall 时会取错（报告 #9）。
 *
 * 翻译对齐 pi 行为（报告 §6）：
 * - tool_execution_update.partialResult → tool_result_partial（工具流式输出，bash stdout 在此）
 * - bash_execution_update → user_bash_output（用户 !cmd，非工具调用，独立事件）
 * - compaction_end.result → compaction{summary,tokensBefore,tokensAfter}
 * - entry_appended(type:model_change) → model_changed（AgentSessionEvent 流里模型切换的唯一实时信号）
 * - entry_appended(type:compaction) 提供持久化身份，compaction_end 再报告成功/失败/取消
 * - auto_retry_start/end → retry（消息终态拥有模型错误，重试事件仅报告过程）
 * - agent_end.willRetry → status:retrying（不过早切 idle）
 * - message_end usage 补 reasoning/stopReason/durationMs/responseModel
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantBlock, ChatMessage, SSEEvent, ToolResultInfo } from "@pi-agent/common";

/** pi 消息 → 前端 messageId（流式期间稳定，history 投影同源对齐） */
export function messageIdOf(message: { timestamp?: number; role?: string }): string {
	return `${message.role ?? "assistant"}:${message.timestamp ?? 0}`;
}

/** 图片是工具内容的一部分，不能在文本投影时被静默丢弃。 */
export function contentImages(
	content: unknown,
): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
	if (!Array.isArray(content)) return undefined;
	const images = content.filter(
		(c) => c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string",
	);
	return images.length ? images : undefined;
}

function userContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

/** pi CompactionResult 形状（按 compaction.ts:104-114，取前端需要的字段） */
interface PiCompactionResult {
	summary?: string;
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	usage?: unknown;
}
interface PiEntry {
	type: string;
	timestamp?: string;
	provider?: string;
	modelId?: string;
	summary?: string;
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	thinkingLevel?: string;
}

/** per-session 翻译器：持有 contentIndex → toolCallId 映射 */
export class EventTranslator {
	private messageIds = new WeakMap<object, string>();
	private currentAssistantId?: string;
	private lastAssistantError?: string;
	private compactionEntry?: PiEntry;
	private compactions = new Map<string, Extract<ChatMessage, { type: "compaction" }>>();

	/** 同一活跃会话的 SSE 与快照共用身份；重启后随全量快照重建。 */
	messageId(message: object): string {
		let id = this.messageIds.get(message);
		if (!id) {
			id = crypto.randomUUID();
			this.messageIds.set(message, id);
		}
		return id;
	}
	/** key = `${messageId}:${contentIndex}` → toolCallId */
	private toolCallIndex = new Map<string, string>();
	private toolResults = new Map<
		string,
		{ status: "running" | "done" | "error"; result: ToolResultInfo }
	>();

	/** 工具 partial 不在 SDK 持久化消息里，快照必须叠加最新执行结果后再配 seq。 */
	decorateMessages(messages: ChatMessage[]): ChatMessage[] {
		return messages.map((message) =>
			message.type !== "assistant"
				? message.type === "compaction"
					? { ...message, ...this.compactions.get(message.id) }
					: message
				: {
						...message,
						blocks: message.blocks.map((block): AssistantBlock => {
							const current =
								block.kind === "toolCall" ? this.toolResults.get(block.toolCallId) : undefined;
							return current
								? ({
										...block,
										result: current.result,
										status:
											(message.stopReason === "aborted" ||
												message.stopReason === "error" ||
												message.stopReason === "length") &&
											current.status === "running" &&
											block.kind === "toolCall"
												? block.status
												: current.status,
									} as AssistantBlock)
								: block;
						}),
					},
		);
	}

	translate(ev: AgentSessionEvent): SSEEvent[] {
		switch (ev.type) {
			case "agent_start":
				this.lastAssistantError = undefined;
				return [{ event: "status", data: { status: "thinking", newRun: true } }];

			case "turn_start":
				return [];

			case "turn_end":
				return [{ event: "turn_end", data: { partial: false } }];

			case "message_start": {
				const msg = ev.message;
				if (msg.role === "user") {
					return [
						{
							event: "user_message",
							data: {
								uuid: this.messageId(msg),
								content: userContentText(msg.content),
								images: contentImages(msg.content),
							},
						},
					];
				}
				if (msg.role === "assistant") {
					this.currentAssistantId = this.messageId(msg);
					return [{ event: "message_start", data: { messageId: this.currentAssistantId } }];
				}
				if (msg.role === "custom" && msg.display !== false)
					return [
						{
							event: "system_message",
							data: {
								id: this.messageId(msg),
								content: contentText(msg.content),
								createdAt: msg.timestamp,
							},
						},
					];
				return [];
			}

			case "message_update": {
				const messageId = this.currentAssistantId ?? this.messageId(ev.message);
				this.currentAssistantId = messageId;
				this.messageIds.set(ev.message, messageId);
				const ame = ev.assistantMessageEvent;
				switch (ame.type) {
					case "text_start":
						return [{ event: "status", data: { status: "responding" } }];
					case "text_delta":
						return [{ event: "text_chunk", data: { messageId, delta: ame.delta } }];
					case "text_end":
						return [];
					case "thinking_start":
						return [{ event: "status", data: { status: "thinking" } }];
					case "thinking_delta":
						return [{ event: "thinking_chunk", data: { messageId, delta: ame.delta } }];
					case "thinking_end":
						return [];
					case "toolcall_start": {
						const toolCall = ame.partial.content[ame.contentIndex];
						if (toolCall?.type !== "toolCall") return [];
						this.toolCallIndex.set(`${messageId}:${ame.contentIndex}`, toolCall.id);
						return [
							{ event: "status", data: { status: "tool-use" } },
							{
								event: "tool_call_start",
								data: { toolCallId: toolCall.id, name: toolCall.name, messageId },
							},
						];
					}
					case "toolcall_delta": {
						const toolCallId = this.toolCallIndex.get(`${messageId}:${ame.contentIndex}`);
						if (!toolCallId) return [];
						return [{ event: "tool_call_args", data: { toolCallId, delta: ame.delta } }];
					}
					case "toolcall_end": {
						const key = `${messageId}:${ame.contentIndex}`;
						const toolCallId = this.toolCallIndex.get(key) ?? ame.toolCall.id;
						this.toolCallIndex.delete(key);
						return [
							{
								event: "tool_call_end",
								data: { toolCallId, argsText: JSON.stringify(ame.toolCall.arguments ?? {}) },
							},
						];
					}
					case "error":
						// message_end owns the final error, including providers that never emit an update error.
						return [];

					default:
						return [];
				}
			}

			case "message_end": {
				const msg = ev.message;
				if (msg.role !== "assistant") return [];
				const messageId = this.currentAssistantId ?? this.messageId(msg);
				this.messageIds.set(msg, messageId);
				this.currentAssistantId = undefined;
				const out: SSEEvent[] = [
					{
						event: "message_end",
						data: {
							messageId,
							stopReason: msg.stopReason,
							errorMessage:
								msg.stopReason === "error" ? (msg.errorMessage ?? "模型响应出错") : undefined,
						},
					},
				];
				this.lastAssistantError =
					msg.stopReason === "error" ? (msg.errorMessage ?? "模型响应出错") : undefined;

				if (msg.usage) {
					out.push({
						event: "usage",
						data: {
							inputTokens: msg.usage.input ?? 0,
							outputTokens: msg.usage.output ?? 0,
							cacheReadTokens: msg.usage.cacheRead ?? 0,
							cacheCreationTokens: msg.usage.cacheWrite ?? 0,
							reasoningTokens: msg.usage.reasoning ?? 0,
							stopReason: msg.stopReason,
							durationMs: msg.durationMs,
							responseModel: msg.responseModel,
						},
					});
				}
				return out;
			}

			case "tool_execution_start":
				return [{ event: "status", data: { status: "tool-use" } }];

			case "tool_execution_update": {
				// partialResult = AgentToolResult：工具 execute() 通过 onUpdate 上报的部分结果
				// bash 工具的实时 stdout 在此（不是 bash_execution_update，那是用户 !cmd）
				const pr = ev.partialResult as
					| { content?: unknown; details?: unknown; isError?: boolean }
					| undefined;
				this.toolResults.set(ev.toolCallId, {
					status: "running",
					result: {
						content: contentText(pr?.content),
						images: contentImages(pr?.content),
						toolUseResult: pr?.details,
					},
				});
				return [
					{
						event: "tool_result_partial",
						data: {
							toolCallId: ev.toolCallId,
							content: contentText(pr?.content),
							images: contentImages(pr?.content),
							details: pr?.details,
							isError: pr?.isError,
						},
					},
				];
			}

			case "tool_execution_end": {
				const result = ev.result as { content?: unknown; details?: unknown } | undefined;
				this.toolResults.set(ev.toolCallId, {
					status: ev.isError ? "error" : "done",
					result: {
						content: contentText(result?.content),
						images: contentImages(result?.content),
						error: ev.isError,
						toolUseResult: result?.details,
						durationMs: ev.durationMs,
					},
				});
				return [
					{
						event: "tool_result",
						data: {
							toolCallId: ev.toolCallId,
							content: contentText(result?.content),
							images: contentImages(result?.content),
							error: ev.isError,
							toolUseResult: result?.details,
							durationMs: ev.durationMs,
						},
					},
				];
			}

			case "agent_end":
				// willRetry：即将自动重试，不切 idle（否则前端过早以为结束）
				return [{ event: "status", data: { status: ev.willRetry ? "thinking" : "idle" } }];

			case "agent_settled":
				this.toolResults.clear();
				this.toolCallIndex.clear();
				return [{ event: "status", data: { status: "idle" } }];

			case "queue_update":
				return [
					{
						event: "queue_update",
						data: { steering: [...ev.steering], followUp: [...ev.followUp] },
					},
				];

			case "thinking_level_changed":
				return [{ event: "thinking_level_changed", data: { level: ev.level } }];

			case "compaction_start":
				this.compactionEntry = undefined;
				return [{ event: "compaction", data: { phase: "start", trigger: ev.reason } }];
			case "compaction_end": {
				const r = ev.result as PiCompactionResult | undefined;
				const outcome = ev.aborted ? "cancelled" : ev.errorMessage || !r ? "error" : "success";
				const createdAt = this.compactionEntry?.timestamp
					? Date.parse(this.compactionEntry.timestamp)
					: Date.now();
				const id = `compaction:${createdAt}`;
				if (outcome === "success" && r) {
					this.compactions.set(id, {
						id,
						type: "compaction",
						createdAt,
						summary: r.summary ?? "",
						tokensBefore: r.tokensBefore,
						tokensAfter: r.estimatedTokensAfter,
						trigger: ev.reason,
					});
				}
				return [
					{
						event: "compaction",
						data: {
							phase: "end",
							id,
							createdAt,
							outcome,
							trigger: ev.reason,
							summary: outcome === "success" ? r?.summary : undefined,
							tokensBefore: r?.tokensBefore,
							tokensAfter: r?.estimatedTokensAfter,
							errorMessage: outcome === "error" ? (ev.errorMessage ?? "压缩未完成") : undefined,
						},
					},
				];
			}

			case "session_info_changed":
				return [{ event: "session_name", data: { name: ev.name } }];

			case "bash_execution_update":
				// 用户 !cmd bash（executeBash），与工具调用独立；id 是调用方追踪 id（非 toolCallId）
				return [{ event: "user_bash_output", data: { id: ev.id, delta: ev.delta } }];

			case "entry_appended": {
				const e = ev.entry as PiEntry;
				// model_change entry：AgentSessionEvent 流里模型切换的唯一实时信号（无 model_select 事件）
				if (e.type === "model_change" && e.provider && e.modelId) {
					return [{ event: "model_changed", data: { provider: e.provider, modelId: e.modelId } }];
				}
				// compaction entry supplies the persisted timestamp shared with history.
				if (e.type === "compaction") {
					// The durable entry supplies identity; only compaction_end reports the operation outcome.
					this.compactionEntry = e;
					return [];
				}

				// 其余 entry（message/thinking_level_change/usage/branch_summary/custom*/context_edit/label/session_info）
				// 已有实时事件或属历史重建，前端 history 投影覆盖，此处不重复投影
				return [];
			}

			case "auto_retry_start":
				return [
					{
						event: "retry",
						data: {
							phase: "start",
							attempt: ev.attempt,
							maxAttempts: ev.maxAttempts,
							delayMs: ev.delayMs,
							message: ev.errorMessage,
						},
					},
				];

			case "auto_retry_end":
				return [
					{
						event: "retry",
						data: {
							phase: "end",
							attempt: ev.attempt,
							success: ev.success,
							message: ev.finalError,
						},
					},
					...(ev.success ||
					ev.finalError === "Retry cancelled" ||
					ev.finalError === this.lastAssistantError
						? []
						: ([
								{ event: "error", data: { message: ev.finalError ?? "重试失败" } },
							] satisfies SSEEvent[])),
				];

			case "summarization_retry_scheduled":
				return [
					{
						event: "retry",
						data: {
							phase: "start",
							attempt: ev.attempt,
							maxAttempts: ev.maxAttempts,
							delayMs: ev.delayMs,
							message: `摘要重试：${ev.errorMessage}`,
						},
					},
				];

			case "summarization_retry_finished":
				return [{ event: "retry", data: { phase: "end", attempt: 0 } }];

			case "summarization_retry_attempt_start":
				// 两个变体（branchSummary / compaction）合并投影，前端只需知道"重试尝试开始"
				return [];

			default:
				return [];
		}
	}
}
