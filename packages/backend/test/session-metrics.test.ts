import { expect, test } from "bun:test";
import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { readSessionMetrics } from "../src/modules/agent/session-metrics";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
function fixture() {
	const sessionManager = SessionManager.inMemory();
	let contextUsage: ReturnType<AgentSession["getContextUsage"]> = {
		tokens: 250,
		contextWindow: 1000,
		percent: 25,
	};
	const session = {
		sessionManager,
		getSessionStats: () =>
			AgentSession.prototype.getSessionStats.call({
				sessionManager,
				sessionId: sessionManager.getSessionId(),
				sessionFile: undefined,
				getContextUsage: () => contextUsage,
			} as unknown as AgentSession),
	};
	const appendAssistant = (u: ReturnType<typeof usage>) =>
		sessionManager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture",
			content: [{ type: "text", text: "answer" }],
			usage: u,
			stopReason: "stop",
			timestamp: Date.now(),
		});
	return {
		session,
		sessionManager,
		appendAssistant,
		setContext: (context: typeof contextUsage) => {
			contextUsage = context;
		},
	};
}

test("TUI totals include all entries while cache hit rate uses only the latest assistant prompt", () => {
	const f = fixture();
	f.appendAssistant(usage(100, 25, 300, 100));
	const last = f.appendAssistant(usage(50, 10, 150));
	f.sessionManager.appendCompaction("summary", last, 2000, undefined, false, usage(20, 5, 30));
	f.sessionManager.appendUsage("cache_warm", "fixture", "fixture", usage(2, 0, 8));
	const metrics = readSessionMetrics(f.session);
	expect(metrics).toMatchObject({
		inputTokens: 172,
		outputTokens: 40,
		cacheReadTokens: 488,
		cacheCreationTokens: 100,
		cacheHitRate: 75,
		contextUsage: { tokens: 250, contextWindow: 1000, percent: 25 },
	});
	expect(metrics.inputTokens).not.toBe(172 + 488 + 100);
	f.setContext({ tokens: null, contextWindow: 1000, percent: null });
	expect(readSessionMetrics(f.session).contextUsage?.percent).toBeNull();
	expect(readSessionMetrics(f.session).inputTokens).toBe(172);
});

test("unknown context and zero-token latest response stay unknown, without reusing an older cache ratio", () => {
	const f = fixture();
	f.setContext(undefined);
	expect(readSessionMetrics(f.session)).toMatchObject({
		inputTokens: 0,
		outputTokens: 0,
		cacheHitRate: null,
		contextUsage: null,
	});
	f.appendAssistant(usage(1, 1, 3));
	expect(readSessionMetrics(f.session).cacheHitRate).toBe(75);
	f.appendAssistant(usage(0, 0));
	expect(readSessionMetrics(f.session).cacheHitRate).toBeNull();
});
