/**
 * 会话历史投影 —— pi JSONL → ChatMessage[]（与 SSE 累积同构，实施计划 §5.7）。
 *
 * 使用 SDK 当前上下文和翻译器消息身份；独立投影以角色、时间和序号区分消息。
 */

import type { AssistantBlock, ChatMessage } from "@pi-agent/common";
import { contentImages, messageIdOf } from "./event-translator";

type PiMessage = {
	role: string;
	timestamp?: number;
	content?: unknown;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	model?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
	summary?: string;
	tokensBefore?: number;
	display?: boolean;
	stopReason?: string;
	errorMessage?: string;
};

function assistantBlocks(content: unknown): AssistantBlock[] {
	const blocks: AssistantBlock[] = [];
	if (!Array.isArray(content)) return blocks;
	for (const c of content as Array<Record<string, unknown>>) {
		if (c.type === "text" && typeof c.text === "string") {
			blocks.push({ kind: "text", text: c.text });
		} else if (c.type === "thinking" && typeof c.thinking === "string") {
			blocks.push({ kind: "thinking", thinking: c.thinking });
		} else if (c.type === "toolCall" && typeof c.id === "string" && typeof c.name === "string") {
			blocks.push({
				kind: "toolCall",
				toolCallId: c.id,
				name: c.name,
				argsText: JSON.stringify(c.arguments ?? {}, null, 2),
				status: "running",
			});
		}
	}
	return blocks;
}

/** pi 消息数组 → 前端 ChatMessage[]（user/assistant/toolResult 三态投影） */
export function projectMessages(
	messages: PiMessage[],
	identify?: (message: PiMessage) => string,
): ChatMessage[] {
	const out: ChatMessage[] = [];
	const occurrences = new Map<string, number>();
	for (const m of messages) {
		const base = messageIdOf(m);
		const ordinal = occurrences.get(base) ?? 0;
		occurrences.set(base, ordinal + 1);
		const id = identify ? identify(m) : ordinal === 0 ? base : `${base}:${ordinal}`;
		if (m.role === "user") {
			const text =
				typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? (m.content as Array<{ type: string; text?: string }>)
								.filter((c) => c.type === "text")
								.map((c) => c.text ?? "")
								.join("")
						: "";
			const images = contentImages(m.content);
			if (text || images?.length)
				out.push({ id, type: "user", content: text, images, createdAt: m.timestamp ?? 0 });
		} else if (m.role === "assistant") {
			const blocks = assistantBlocks(m.content);
			if (m.stopReason === "error" || m.stopReason === "aborted" || m.stopReason === "length")
				for (const block of blocks)
					if (block.kind === "toolCall")
						block.status = m.stopReason === "aborted" ? "cancelled" : "error";
			out.push({
				id,
				type: "assistant",
				blocks,
				model: m.model,
				stopReason: m.stopReason,
				errorMessage: m.stopReason === "error" ? (m.errorMessage ?? "模型响应出错") : undefined,
				usage: m.usage
					? {
							inputTokens: m.usage.input ?? 0,
							outputTokens: m.usage.output ?? 0,
							cacheReadTokens: m.usage.cacheRead ?? 0,
							cacheCreationTokens: m.usage.cacheWrite ?? 0,
							stopReason: m.stopReason,
						}
					: undefined,
				createdAt: m.timestamp ?? 0,
			});
		} else if (m.role === "toolResult") {
			// 工具结果附着到最近的 assistant 消息 toolCall 块；找不到则丢弃（孤立结果不渲染）
			const target = [...out]
				.reverse()
				.find(
					(msg) =>
						msg.type === "assistant" &&
						msg.blocks.some((b) => b.kind === "toolCall" && b.toolCallId === m.toolCallId),
				);
			if (target?.type === "assistant") {
				const block = target.blocks.find(
					(b): b is Extract<AssistantBlock, { kind: "toolCall" }> =>
						b.kind === "toolCall" && b.toolCallId === m.toolCallId,
				);
				if (block) {
					const contentArr = m.content as Array<{ type: string; text?: string }> | undefined;
					block.status = m.isError ? "error" : "done";
					block.result = {
						content: Array.isArray(contentArr)
							? contentArr
									.filter((c) => c.type === "text")
									.map((c) => c.text ?? "")
									.join("\n")
							: "",
						images: contentImages(m.content),
						error: m.isError,
						toolUseResult: m.details,
					};
				}
			}
		} else if (m.role === "compactionSummary") {
			out.push({
				id: `compaction:${m.timestamp ?? 0}`,
				type: "compaction",
				createdAt: m.timestamp ?? 0,
				summary: m.summary ?? "",
				tokensBefore: m.tokensBefore,
			});
		} else if (
			m.role === "branchSummary" ||
			(m.role === "custom" && m.display !== false) ||
			m.role === "bashExecution"
		) {
			const text =
				m.summary ??
				(typeof m.content === "string"
					? m.content
					: Array.isArray(m.content)
						? (m.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n")
						: "");
			if (text) out.push({ id, type: "system", content: text, createdAt: m.timestamp ?? 0 });
		}
	}
	return out;
}
