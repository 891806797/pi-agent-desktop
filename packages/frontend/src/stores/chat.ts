/**
 * chat store —— common 快照和 SSE 事件的唯一页面状态。
 *
 * 一致性三件套：
 * - seq 幂等：ev.seq <= lastSeq 丢弃（多 tab / 重放重复）
 * - 跳洞：SSE 层 RESYNC 信号触发全量对账（useChatAgent 处理），store 只管状态
 * - O(1) 索引：messageIndex（messageId → 消息）、toolUsePos（toolCallId → 块位置）
 *
 * ponytail: chunk 直接 set（React 批处理够用）；流式卡顿明显再上 rAF 聚合
 */

import type {
	AgentStatus,
	AssistantBlock,
	ChatMessage,
	HistoryResponse,
	ModelRef,
	PendingRequest,
	RunMode,
	SequencedEvent,
	SessionCloseReason,
	SessionMetrics,
	ThinkingLevel,
} from "@pi-agent/common";
import { create } from "zustand";

interface ChatStore {
	sessionId: string | null;
	closed: { reason: SessionCloseReason } | null;
	status: AgentStatus;
	messages: ChatMessage[];
	messageIndex: Map<string, ChatMessage>;
	toolUsePos: Map<string, { messageId: string; blockIndex: number }>;
	queue: { steering: string[]; followUp: string[]; revision?: number };
	approvals: Map<string, PendingRequest>;
	runMode: RunMode;
	model: ModelRef | null;
	thinkingLevel: ThinkingLevel;
	lastSeq: number;
	isCompacting: boolean;
	availableThinkingLevels: ThinkingLevel[];
	isSwitchingSession: boolean;
	lastError: string | null;
	metrics: SessionMetrics | null;

	applyEvent: (ev: SequencedEvent) => void;
	loadSnapshot: (snapshot: HistoryResponse) => void;
	setSession: (sessionId: string) => void;
	setModel: (m: ModelRef | null) => void;
	setRunMode: (mode: RunMode) => void;
	setThinking: (level: ThinkingLevel) => void;
	reset: () => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
	sessionId: null,
	closed: null,
	status: "idle",
	messages: [],
	messageIndex: new Map(),
	toolUsePos: new Map(),
	queue: { steering: [], followUp: [] },
	approvals: new Map(),
	runMode: "standard",
	model: null,
	thinkingLevel: "off",
	lastSeq: 0,
	isCompacting: false,
	availableThinkingLevels: ["off"],
	isSwitchingSession: false,
	lastError: null,
	metrics: null,

	applyEvent: (ev) => {
		const state = get();
		// seq 幂等（seq=0 是无序事件：挂起审批重放）
		if (ev.seq !== 0) {
			if (ev.seq <= state.lastSeq) return;
			if (ev.seq > state.lastSeq + 1) {
				// 跳洞：RESYNC 流程兜底，此处仅记录不处理
				console.warn(`[chat] seq 跳洞 ${state.lastSeq} → ${ev.seq}`);
			}
		}

		// Events without a visible projection still consume their sequence.
		if (ev.seq) set({ lastSeq: ev.seq });
		const set_ = (patch: Partial<ChatStore>) =>
			set(() => ({
				...patch,
				...(ev.seq !== 0 ? { lastSeq: Math.max(ev.seq, get().lastSeq) } : {}),
			}));

		switch (ev.event) {
			case "session_metrics":
				return set_({ metrics: ev.data });
			case "system_message": {
				if (state.messageIndex.has(ev.data.id)) return;
				const message: ChatMessage = { type: "system", ...ev.data };
				return set_({
					messages: [...state.messages, message],
					messageIndex: new Map(state.messageIndex).set(message.id, message),
				});
			}
			case "status":
				return set_({ status: ev.data.status, ...(ev.data.newRun ? { lastError: null } : {}) });
			case "session":
				return set_({ sessionId: ev.data.sessionId });
			case "user_message": {
				if (state.messageIndex.has(ev.data.uuid)) return;
				const msg: ChatMessage = {
					id: ev.data.uuid,
					type: "user",
					content: ev.data.content,
					images: ev.data.images,
					createdAt: Date.now(),
				};
				return set_({
					messages: [...state.messages, msg],
					messageIndex: new Map(state.messageIndex).set(msg.id, msg),
				});
			}
			case "message_start": {
				if (state.messageIndex.has(ev.data.messageId)) return;
				const msg: ChatMessage = {
					id: ev.data.messageId,
					type: "assistant",
					blocks: [],
					createdAt: Date.now(),
				};
				return set_({
					messages: [...state.messages, msg],
					messageIndex: new Map(state.messageIndex).set(msg.id, msg),
				});
			}
			case "text_chunk":
			case "thinking_chunk": {
				const msg = state.messageIndex.get(ev.data.messageId);
				if (msg?.type !== "assistant") return;
				const blocks = [...msg.blocks];
				const last = blocks[blocks.length - 1];
				if (ev.event === "text_chunk") {
					if (last?.kind === "text") {
						blocks[blocks.length - 1] = { kind: "text", text: last.text + ev.data.delta };
					} else {
						blocks.push({ kind: "text", text: ev.data.delta });
					}
				} else {
					if (last?.kind === "thinking") {
						blocks[blocks.length - 1] = {
							kind: "thinking",
							thinking: last.thinking + ev.data.delta,
						};
					} else {
						blocks.push({ kind: "thinking", thinking: ev.data.delta });
					}
				}
				const updated = { ...msg, blocks };
				return set_({
					messages: replaceById(state.messages, updated),
					messageIndex: replaceInMap(state.messageIndex, updated),
				});
			}
			case "tool_call_start": {
				const msg = state.messageIndex.get(ev.data.messageId);
				if (msg?.type !== "assistant") return;
				const blocks = [...msg.blocks];
				const blockIndex = blocks.length;
				blocks.push({
					kind: "toolCall",
					toolCallId: ev.data.toolCallId,
					name: ev.data.name,
					parentToolCallId: ev.data.parentToolCallId,
					argsText: "",
					status: "streaming",
				});
				const updated = { ...msg, blocks };
				return set_({
					messages: replaceById(state.messages, updated),
					messageIndex: replaceInMap(state.messageIndex, updated),
					toolUsePos: new Map(state.toolUsePos).set(ev.data.toolCallId, {
						messageId: ev.data.messageId,
						blockIndex,
					}),
				});
			}
			case "tool_call_args": {
				const pos = state.toolUsePos.get(ev.data.toolCallId);
				if (!pos) return;
				const msg = state.messageIndex.get(pos.messageId);
				if (msg?.type !== "assistant") return;
				const block = msg.blocks[pos.blockIndex];
				if (block?.kind !== "toolCall") return;
				const blocks = [...msg.blocks];
				blocks[pos.blockIndex] = { ...block, argsText: block.argsText + ev.data.delta };
				const updated = { ...msg, blocks };
				return set_({
					messages: replaceById(state.messages, updated),
					messageIndex: replaceInMap(state.messageIndex, updated),
				});
			}
			case "tool_call_end": {
				const updated = updateToolBlock(state, ev.data.toolCallId, (b) => ({
					...b,
					status: b.status === "streaming" ? "running" : b.status,
					argsText: ev.data.argsText ?? b.argsText,
				}));
				if (!updated) return;
				return set_({
					messages: replaceById(state.messages, updated.message),
					messageIndex: replaceInMap(state.messageIndex, updated.message),
				});
			}
			case "tool_result_partial": {
				const updated = updateToolBlock(state, ev.data.toolCallId, (b) => ({
					...b,
					status: "running",
					result: {
						content: ev.data.content,
						images: ev.data.images,
						error: ev.data.isError,
						toolUseResult: ev.data.details,
					},
				}));
				if (updated)
					return set_({
						messages: replaceById(state.messages, updated.message),
						messageIndex: replaceInMap(state.messageIndex, updated.message),
					});
				return;
			}
			case "tool_result": {
				const updated = updateToolBlock(state, ev.data.toolCallId, (b) => ({
					...b,
					status: ev.data.error ? "error" : "done",
					result: {
						content: ev.data.content,
						images: ev.data.images,
						error: ev.data.error,
						toolUseResult: ev.data.toolUseResult,
						durationMs: ev.data.durationMs,
					},
				}));
				if (!updated) return;
				return set_({
					messages: replaceById(state.messages, updated.message),
					messageIndex: replaceInMap(state.messageIndex, updated.message),
				});
			}
			case "usage": {
				// usage 事件不携带 messageId：附着到最近一条 assistant 消息
				const last = [...state.messages].reverse().find((m) => m.type === "assistant");
				if (last?.type !== "assistant") return;
				const updated = { ...last, usage: ev.data };
				return set_({
					messages: replaceById(state.messages, updated),
					messageIndex: replaceInMap(state.messageIndex, updated),
				});
			}
			case "message_end": {
				const msg = state.messageIndex.get(ev.data.messageId);
				if (msg?.type !== "assistant") return;
				const terminal =
					ev.data.stopReason === "aborted" ||
					ev.data.stopReason === "error" ||
					ev.data.stopReason === "length";
				const updated = {
					...msg,
					stopReason: ev.data.stopReason,
					errorMessage: ev.data.errorMessage,
					blocks: terminal
						? msg.blocks.map(
								(b): AssistantBlock =>
									b.kind === "toolCall" && (b.status === "streaming" || b.status === "running")
										? { ...b, status: ev.data.stopReason === "aborted" ? "cancelled" : "error" }
										: b,
							)
						: msg.blocks,
				};
				return set_({
					messages: replaceById(state.messages, updated),
					messageIndex: replaceInMap(state.messageIndex, updated),
					...(ev.data.errorMessage ? { lastError: ev.data.errorMessage } : {}),
				});
			}
			case "approval_request": {
				if (state.approvals.has(ev.data.requestId)) return;
				return set_({ approvals: new Map(state.approvals).set(ev.data.requestId, ev.data) });
			}
			case "approval_settled": {
				if (!state.approvals.has(ev.data.requestId)) return;
				const approvals = new Map(state.approvals);
				approvals.delete(ev.data.requestId);
				return set_({ approvals });
			}
			case "queue_update":
				return set_({ queue: ev.data });
			case "run_mode":
				return set_({ runMode: ev.data.mode });
			case "model_changed":
				return set_({
					model: { provider: ev.data.provider, modelId: ev.data.modelId },
					...(ev.data.availableThinkingLevels
						? { availableThinkingLevels: ev.data.availableThinkingLevels }
						: {}),
				});
			case "thinking_level_changed":
				return set_({ thinkingLevel: ev.data.level });
			case "compaction": {
				if (ev.data.phase === "start") return set_({ isCompacting: true });
				if (ev.data.outcome !== "success" || ev.data.summary === undefined)
					return set_({
						isCompacting: false,
						...(ev.data.errorMessage ? { lastError: ev.data.errorMessage } : {}),
					});
				const id = ev.data.id ?? `compaction:${ev.data.createdAt ?? ev.seq}`;
				const msg: ChatMessage = {
					id,
					type: "compaction",
					createdAt: ev.data.createdAt ?? Date.now(),
					summary: ev.data.summary,
					tokensBefore: ev.data.tokensBefore,
					tokensAfter: ev.data.tokensAfter,
					trigger: ev.data.trigger,
				};
				return set_({
					isCompacting: false,
					messages: state.messageIndex.has(id)
						? replaceById(state.messages, msg)
						: [...state.messages, msg],
					messageIndex: replaceInMap(state.messageIndex, msg),
				});
			}
			case "retry":
				return set_({
					lastError:
						ev.data.phase === "start"
							? `正在重试（${ev.data.attempt}）：${ev.data.message ?? ""}`
							: null,
				});
			case "user_bash_output": {
				const id = `bash-${ev.data.id ?? "output"}`;
				const prev = state.messageIndex.get(id);
				const msg: ChatMessage = {
					id,
					type: "system",
					content: (prev?.type === "system" ? prev.content : "") + ev.data.delta,
					createdAt: prev?.createdAt ?? Date.now(),
				};
				return set_({
					messages: prev ? replaceById(state.messages, msg) : [...state.messages, msg],
					messageIndex: replaceInMap(state.messageIndex, msg),
				});
			}
			case "session_name":
				return;
			case "error": {
				const msg = ev.data?.message ?? "未知错误";
				const err: ChatMessage = {
					id: `err-${Date.now()}`,
					type: "system",
					content: msg,
					createdAt: Date.now(),
				};
				return set_({ messages: [...state.messages, err], lastError: msg });
			}
			case "turn_end":
				return;
			case "query_closed": {
				const msg: ChatMessage = {
					id: `closed-${Date.now()}`,
					type: "system",
					content: `会话已关闭（${ev.data.reason}）`,
					createdAt: Date.now(),
				};
				return set_({
					messages: [...state.messages, msg],
					status: "idle",
					closed: { reason: ev.data.reason },
					isCompacting: false,
					approvals: new Map(),
				});
			}
			case "commands":
				return;
		}
	},

	loadSnapshot: (h) => {
		const messageIndex = new Map(h.messages.map((m) => [m.id, m]));
		const toolUsePos = new Map<string, { messageId: string; blockIndex: number }>();
		for (const m of h.messages)
			if (m.type === "assistant")
				m.blocks.forEach((b, i) => {
					if (b.kind === "toolCall")
						toolUsePos.set(b.toolCallId, { messageId: m.id, blockIndex: i });
				});
		set({
			sessionId: h.sessionId,
			closed: null,
			messages: h.messages,
			messageIndex,
			toolUsePos,
			lastSeq: h.seq,
			status: h.status,
			queue: h.queue,
			approvals: new Map(h.pendingApprovals.map((r) => [r.requestId, r])),
			model: h.model,
			thinkingLevel: h.thinkingLevel,
			availableThinkingLevels: h.availableThinkingLevels,
			runMode: h.runMode,
			isCompacting: h.isCompacting,
			metrics: h.metrics,
			isSwitchingSession: false,
			lastError: null,
		});
	},
	setSession: (sessionId) => set({ sessionId }),
	setModel: (model) => set({ model }),
	setRunMode: (runMode) => set({ runMode }),
	setThinking: (thinkingLevel) => set({ thinkingLevel }),
	reset: () =>
		set({
			sessionId: null,
			closed: null,
			runMode: "standard",
			status: "idle",
			messages: [],
			messageIndex: new Map(),
			toolUsePos: new Map(),
			queue: { steering: [], followUp: [] },
			approvals: new Map(),
			model: null,
			thinkingLevel: "off",
			lastSeq: 0,
			isCompacting: false,
			availableThinkingLevels: ["off"],
			isSwitchingSession: false,
			lastError: null,
			metrics: null,
		}),
}));

function replaceById(messages: ChatMessage[], updated: ChatMessage): ChatMessage[] {
	return messages.map((m) => (m.id === updated.id ? updated : m));
}

function replaceInMap(
	map: Map<string, ChatMessage>,
	updated: ChatMessage,
): Map<string, ChatMessage> {
	return new Map(map).set(updated.id, updated);
}

function updateToolBlock(
	state: ChatStore,
	toolCallId: string,
	mutate: (
		b: Extract<AssistantBlock, { kind: "toolCall" }>,
	) => Extract<AssistantBlock, { kind: "toolCall" }>,
): { message: ChatMessage } | null {
	const pos = state.toolUsePos.get(toolCallId);
	if (!pos) return null;
	const msg = state.messageIndex.get(pos.messageId);
	if (msg?.type !== "assistant") return null;
	const block = msg.blocks[pos.blockIndex];
	if (block?.kind !== "toolCall") return null;
	const blocks = [...msg.blocks];
	blocks[pos.blockIndex] = mutate(block);
	return { message: { ...msg, blocks } };
}
