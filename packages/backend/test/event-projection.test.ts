import { expect, test } from "bun:test";
import { EventTranslator } from "../src/modules/agent/event-translator";
import { projectMessages } from "../src/modules/agent/history";

test("user images survive both live events and image-only history", () => {
	const message = {
		role: "user",
		timestamp: 1,
		content: [{ type: "image", data: "fixture", mimeType: "image/png" }],
	};
	const translator = new EventTranslator();
	expect(translator.translate({ type: "message_start", message } as never)[0]?.data).toMatchObject({
		images: message.content,
	});
	expect(projectMessages([message])[0]).toMatchObject({ type: "user", images: message.content });
});

test("length-limited replies mark unfinished tool calls as failed in history", () => {
	expect(
		projectMessages([
			{
				role: "assistant",
				timestamp: 1,
				stopReason: "length",
				content: [{ type: "toolCall", id: "t", name: "write", arguments: {} }],
			},
		])[0],
	).toMatchObject({ blocks: [{ status: "error" }] });
});

test("compaction entry and end share one identity and failed/cancelled ends do not claim success", () => {
	const t = new EventTranslator();
	t.translate({ type: "compaction_start", reason: "manual" } as never);
	const entry = t.translate({
		type: "entry_appended",
		entry: {
			type: "compaction",
			timestamp: "2026-11-01T00:00:00Z",
			summary: "summary",
			tokensBefore: 100,
		},
	} as never);
	const end = t.translate({
		type: "compaction_end",
		reason: "manual",
		result: { summary: "summary", tokensBefore: 100, estimatedTokensAfter: 20 },
		aborted: false,
	} as never);
	const results = [...entry, ...end].filter(
		(e) => e.event === "compaction" && e.data.phase === "end",
	);
	expect(results).toHaveLength(1);
	expect(results[0]?.data).toMatchObject({
		id: "compaction:1793491200000",
		outcome: "success",
		tokensAfter: 20,
	});
	const history = t.decorateMessages(
		projectMessages([
			{
				role: "compactionSummary",
				summary: "summary",
				tokensBefore: 100,
				timestamp: 1793491200000,
			},
		]),
	);
	expect(history[0]).toMatchObject({
		type: "compaction",
		id: "compaction:1793491200000",
		summary: "summary",
		tokensAfter: 20,
	});
	for (const aborted of [true, false]) {
		const e = t.translate({
			type: "compaction_end",
			reason: "manual",
			aborted,
			errorMessage: aborted ? undefined : "failed",
		} as never);
		expect(e[0]?.data).toMatchObject({ outcome: aborted ? "cancelled" : "error" });
	}
});
test("provider error has one message-owned terminal result; retry exhaustion and abort do not duplicate generic errors", () => {
	const t = new EventTranslator();
	expect(t.translate({ type: "agent_start" } as never)[0]?.data).toMatchObject({ newRun: true });
	const message = {
		role: "assistant",
		timestamp: 1,
		content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }],
		stopReason: "error",
		errorMessage: "429 quota",
	};
	t.translate({ type: "message_start", message } as never);
	const events = [
		...t.translate({ type: "message_end", message } as never),
		...t.translate({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "429 quota",
		} as never),
	];
	expect(events.filter((e) => e.event === "error")).toHaveLength(0);
	expect(events.find((e) => e.event === "message_end")?.data).toMatchObject({
		errorMessage: "429 quota",
	});
	expect(projectMessages([message])[0]).toMatchObject({
		errorMessage: "429 quota",
		blocks: [{ status: "error" }],
	});
	expect(
		t.translate({ type: "agent_settled", aborted: true } as never).some((e) => e.event === "error"),
	).toBe(false);
	expect(projectMessages([{ ...message, stopReason: "aborted" }])[0]).toMatchObject({
		errorMessage: undefined,
		blocks: [{ status: "cancelled" }],
	});
});

test("aborting a partially executed tool keeps its partial output but never restores running state in snapshot", () => {
	const t = new EventTranslator();
	t.translate({
		type: "tool_execution_update",
		toolCallId: "t",
		partialResult: { content: [{ type: "text", text: "partial output" }] },
	} as never);
	const messages = projectMessages([
		{
			role: "assistant",
			timestamp: 1,
			stopReason: "aborted",
			content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }],
		},
	]);
	expect(t.decorateMessages(messages)[0]).toMatchObject({
		blocks: [{ status: "cancelled", result: { content: "partial output" } }],
	});
	expect(
		t
			.translate({
				type: "auto_retry_end",
				success: false,
				attempt: 1,
				finalError: "Retry cancelled",
			} as never)
			.some((e) => e.event === "error"),
	).toBe(false);
});
