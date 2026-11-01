import { afterEach, expect, test } from "bun:test";
import type { ChatMessage } from "@pi-agent/common";
import { useChatStore } from "../src/stores/chat";

afterEach(() => useChatStore.getState().reset());
test("restart recovery notices render once when live events and replay overlap", () => {
	const data = { id: "custom:1", content: "服务重启后恢复本轮任务", createdAt: 1 };
	const apply = useChatStore.getState().applyEvent;
	apply({ seq: 1, event: "system_message", data });
	apply({ seq: 2, event: "system_message", data });
	apply({ seq: 2, event: "system_message", data });
	expect(useChatStore.getState().messages).toEqual([{ type: "system", ...data }]);
});
test("live compaction is visible and replay is idempotent; cancellation clears progress without a success divider", () => {
	const apply = useChatStore.getState().applyEvent;
	apply({ seq: 1, event: "compaction", data: { phase: "start" } });
	const data = {
		phase: "end",
		id: "c",
		createdAt: 1,
		outcome: "success",
		summary: "summary",
		tokensBefore: 100,
		tokensAfter: 20,
	} as const;
	apply({ seq: 2, event: "compaction", data });
	apply({ seq: 3, event: "compaction", data });
	expect(useChatStore.getState().messages).toHaveLength(1);
	expect(useChatStore.getState().messages[0]).toMatchObject({
		type: "compaction",
		summary: "summary",
		tokensAfter: 20,
	});
	apply({ seq: 4, event: "compaction", data: { phase: "start" } });
	apply({ seq: 5, event: "compaction", data: { phase: "end", outcome: "cancelled" } });
	expect(useChatStore.getState().isCompacting).toBe(false);
	expect(useChatStore.getState().messages).toHaveLength(1);
	apply({
		seq: 6,
		event: "compaction",
		data: { phase: "end", outcome: "error", errorMessage: "compression failed" },
	});
	expect(useChatStore.getState().lastError).toBe("compression failed");
	expect(useChatStore.getState().messages).toHaveLength(1);
});
test("terminal message settles unfinished tools and keeps error on assistant; a new round clears footer only", () => {
	const apply = useChatStore.getState().applyEvent;
	apply({ seq: 1, event: "message_start", data: { messageId: "m" } });
	apply({
		seq: 2,
		event: "tool_call_start",
		data: { messageId: "m", toolCallId: "t", name: "bash" },
	});
	apply({
		seq: 3,
		event: "message_end",
		data: { messageId: "m", stopReason: "error", errorMessage: "quota" },
	});
	expect(useChatStore.getState().messages[0]).toMatchObject({
		errorMessage: "quota",
		blocks: [{ status: "error" }],
	});
	expect(useChatStore.getState().lastError).toBe("quota");
	apply({ seq: 4, event: "status", data: { status: "thinking", newRun: true } });
	expect(useChatStore.getState().lastError).toBe(null);
	expect(useChatStore.getState().messages[0]).toMatchObject({ errorMessage: "quota" });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantBubble, CompactionDivider } from "../src/components/chat/ChatMessageList";

test("actual message renderers keep compaction summaries/tokens, failure text and abort tool state", () => {
	const compaction: Extract<ChatMessage, { type: "compaction" }> = {
		id: "c",
		type: "compaction",
		summary: "保留的摘要",
		tokensBefore: 100,
		tokensAfter: 20,
		createdAt: 1,
	};
	if (compaction.type !== "compaction") throw Error("projection");
	const compactHtml = renderToStaticMarkup(
		createElement(CompactionDivider, { message: compaction }),
	);
	expect(compactHtml).toContain("保留的摘要");
	expect(compactHtml).toContain("压缩后");
	for (const stopReason of ["error", "aborted"]) {
		const message: Extract<ChatMessage, { type: "assistant" }> = {
			id: "m",
			type: "assistant",
			createdAt: 1,
			stopReason,
			errorMessage: stopReason === "error" ? "429 quota" : undefined,
			blocks: [
				{
					kind: "toolCall",
					toolCallId: "t",
					name: "bash",
					argsText: "{}",
					status: stopReason === "aborted" ? "cancelled" : "error",
				},
			],
		};
		if (message.type !== "assistant") throw Error("projection");
		const html = renderToStaticMarkup(createElement(AssistantBubble, { message }));
		expect(html).toContain(stopReason === "error" ? "429 quota" : "已中断");
		expect(html).toContain(stopReason === "error" ? "失败" : "已取消");
	}
});
