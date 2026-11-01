import { afterEach, expect, test } from "bun:test";
import type { HistoryResponse, SequencedEvent } from "@pi-agent/common";
import { ChatSseClient } from "../src/lib/sse-client";
import { useChatStore } from "../src/stores/chat";

type Frame = { data?: string; lastEventId?: string };
const originalEventSource = globalThis.EventSource;
class FakeSource {
	static instances: FakeSource[] = [];
	listeners = new Map<string, Array<(e: Frame) => void>>();
	closed = false;
	onopen?: () => void;
	constructor(public url: string) {
		FakeSource.instances.push(this);
	}
	addEventListener(name: string, fn: (e: Frame) => void) {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
	}
	emit(name: string, seq: number, data: unknown) {
		for (const fn of this.listeners.get(name) ?? [])
			fn({ lastEventId: String(seq), data: JSON.stringify(data) });
	}
	close() {
		this.closed = true;
	}
}
const clients: ChatSseClient[] = [];
afterEach(() => {
	clients.forEach((c) => {
		c.stop();
	});
	clients.length = 0;
	FakeSource.instances = [];
	useChatStore.getState().reset();
	globalThis.EventSource = originalEventSource;
});
function client(seq = 0) {
	globalThis.EventSource = FakeSource as unknown as typeof EventSource;
	const events: SequencedEvent[] = [];
	let resyncs = 0;
	const c = new ChatSseClient(
		"s",
		"w",
		{ onEvent: (e) => events.push(e), onResync: () => resyncs++ },
		seq,
	);
	clients.push(c);
	c.start();
	return {
		c,
		events,
		get resyncs() {
			return resyncs;
		},
		get es() {
			return FakeSource.instances.at(-1)!;
		},
	};
}
test("SSE resync is control only and error listener registered once", () => {
	const x = client();
	expect(x.es.listeners.get("error")?.length).toBe(1);
	x.es.emit("error", 0, { message: "__resync__" });
	expect(x.resyncs).toBe(1);
	expect(x.events).toHaveLength(0);
	expect(x.es.closed).toBe(true);
});
test("SSE detects gaps, ignores duplicates, handles partial/retry, reconnects latest cursor", () => {
	const x = client(8);
	x.es.emit("retry", 9, { phase: "start", attempt: 1 });
	x.es.emit("retry", 9, {});
	expect(x.events).toHaveLength(1);
	x.c.start();
	expect(x.es.url).toContain("sinceSeq=9");
	x.es.emit("tool_result_partial", 11, { toolCallId: "t", content: "x" });
	expect(x.resyncs).toBe(1);
	expect(x.events).toHaveLength(1);
});
test("named heartbeat does not advance cursor ahead of pending frames", () => {
	const x = client(4);
	expect(x.es.listeners.has("heartbeat")).toBe(true);
	x.es.emit("heartbeat", 0, { seq: 10 });
	x.es.emit("status", 5, { status: "responding" });
	expect(x.events).toHaveLength(1);
	expect(x.resyncs).toBe(0);
});

test("session metrics are delivered in SSE sequence and replay is ignored", () => {
	const x = client(3);
	x.es.emit("session_metrics", 4, { inputTokens: 120, outputTokens: 75, cacheHitRate: 60 });
	x.es.emit("session_metrics", 4, { inputTokens: 240 });
	expect(x.events).toHaveLength(1);
	expect(x.events[0]).toMatchObject({
		event: "session_metrics",
		seq: 4,
		data: { inputTokens: 120 },
	});
	expect(x.resyncs).toBe(0);
});
test("snapshot atomically replaces every session state and ignored events advance cursor", () => {
	const h: HistoryResponse = {
		sessionId: "s",
		workspace: "w",
		messages: [],
		seq: 7,
		status: "responding",
		isCompacting: true,
		model: null,
		thinkingLevel: "high",
		availableThinkingLevels: ["off", "high"],
		runMode: "safe",
		queue: { steering: ["a"], followUp: ["b"] },
		pendingApprovals: [
			{ requestId: "r", kind: "ui_confirm", payload: { title: "ok", message: "" }, createdAt: 1 },
		],
	};
	useChatStore.getState().loadSnapshot(h);
	const s = useChatStore.getState();
	expect(s.sessionId).toBe("s");
	expect(s.status).toBe("responding");
	expect(s.queue).toEqual(h.queue);
	expect(s.approvals.has("r")).toBe(true);
	expect(s.isCompacting).toBe(true);
	expect(s.thinkingLevel).toBe("high");
	s.applyEvent({ seq: 8, event: "session_name", data: { name: "n" } });
	expect(useChatStore.getState().lastSeq).toBe(8);
});
test("tool partial stays running, final args/result/stop reason are retained", () => {
	const emit = useChatStore.getState().applyEvent;
	emit({ seq: 1, event: "message_start", data: { messageId: "m" } });
	emit({
		seq: 2,
		event: "tool_call_start",
		data: { messageId: "m", toolCallId: "t", name: "bash" },
	});
	emit({ seq: 3, event: "tool_result_partial", data: { toolCallId: "t", content: "partial" } });
	const tool = () => {
		const m = useChatStore.getState().messages[0];
		if (m?.type !== "assistant") throw Error("expected assistant");
		const b = m.blocks[0];
		if (b?.kind !== "toolCall") throw Error("expected tool block");
		return b;
	};
	expect(tool().status).toBe("running");
	expect(tool().result?.content).toBe("partial");
	emit({
		seq: 4,
		event: "tool_call_end",
		data: { toolCallId: "t", argsText: '{"command":"pwd"}' },
	});
	emit({
		seq: 5,
		event: "tool_result",
		data: {
			toolCallId: "t",
			content: "done",
			images: [{ type: "image", data: "abc", mimeType: "image/png" }],
		},
	});
	emit({ seq: 6, event: "message_end", data: { messageId: "m", stopReason: "aborted" } });
	expect(tool().argsText).toContain("pwd");
	expect(tool().result?.images).toHaveLength(1);
	const message = useChatStore.getState().messages[0];
	expect(message?.type === "assistant" ? message.stopReason : undefined).toBe("aborted");
});

test("network error enters recovery without becoming business error", () => {
	const x = client(2);
	for (const listener of x.es.listeners.get("error") ?? []) listener({});
	expect(x.resyncs).toBe(1);
	expect(x.events).toHaveLength(0);
});
test("watchdog reopens at latest cursor and named heartbeat replaces watchdog", () => {
	const originalSet = globalThis.setTimeout,
		originalClear = globalThis.clearTimeout;
	const scheduled = new Map<number, () => void>();
	let id = 0;
	globalThis.setTimeout = ((fn: () => void) => {
		scheduled.set(++id, fn);
		return id;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: number) => {
		scheduled.delete(handle);
	}) as typeof clearTimeout;
	try {
		const x = client(3);
		const initial = [...scheduled.keys()][0];
		x.es.emit("heartbeat", 0, { seq: 10 });
		expect(scheduled.has(initial)).toBe(false);
		x.es.emit("status", 4, { status: "responding" });
		const fire = [...scheduled.values()][0];
		fire();
		expect(x.es.url).toContain("sinceSeq=4");
		x.c.stop();
		expect(scheduled.size).toBe(0);
	} finally {
		globalThis.setTimeout = originalSet;
		globalThis.clearTimeout = originalClear;
	}
});

test("query_closed ends subscription permanently and ignores subsequent transport errors", () => {
	const x = client();
	const old = x.es;
	x.es.emit("query_closed", 1, { reason: "user_close" });
	expect(old.closed).toBe(true);
	for (const listener of old.listeners.get("error") ?? []) listener({});
	x.c.start();
	expect(FakeSource.instances).toHaveLength(1);
	expect(x.resyncs).toBe(0);
});
