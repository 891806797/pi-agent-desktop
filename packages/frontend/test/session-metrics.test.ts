import { afterEach, expect, test } from "bun:test";
import type { HistoryResponse, SessionMetrics } from "@pi-agent/common";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionMetricsBar } from "../src/components/layout/SessionMetricsBar";
import { useChatStore } from "../src/stores/chat";

const metrics: SessionMetrics = {
	inputTokens: 12000,
	outputTokens: 2000,
	cacheReadTokens: 30000,
	cacheCreationTokens: 1000,
	cacheHitRate: 75,
	contextUsage: { tokens: 32000, contextWindow: 128000, percent: 25 },
};
afterEach(() => useChatStore.getState().reset());

test("metrics replace with snapshots/SSE, ignore replay and clear on session switch", () => {
	const store = useChatStore.getState();
	store.loadSnapshot({
		sessionId: "s",
		messages: [],
		seq: 4,
		pendingApprovals: [],
		metrics,
		queue: { steering: [], followUp: [] },
		availableThinkingLevels: ["off"],
	} as unknown as HistoryResponse);
	expect(useChatStore.getState().metrics).toEqual(metrics);
	const compacted = {
		...metrics,
		contextUsage: { tokens: null, contextWindow: 128000, percent: null },
	};
	store.applyEvent({ seq: 5, event: "session_metrics", data: compacted });
	store.applyEvent({ seq: 4, event: "session_metrics", data: metrics });
	expect(useChatStore.getState().metrics).toEqual(compacted);
	store.reset();
	expect(useChatStore.getState().metrics).toBeNull();
});

test("header shows TUI counts, recent hit ratio and an honest unknown context", () => {
	const html = renderToStaticMarkup(createElement(SessionMetricsBar, { metrics }));
	for (const text of ["上下文", "25.0%", "输入", "12.0K", "输出", "2.0K", "缓存", "75.0%"])
		expect(html).toContain(text);
	const unknown = renderToStaticMarkup(
		createElement(SessionMetricsBar, {
			metrics: {
				...metrics,
				cacheHitRate: null,
				contextUsage: { tokens: null, percent: null, contextWindow: 128000 },
			},
		}),
	);
	expect(unknown).toContain("待更新");
	expect(unknown).not.toContain("0.0%");
});
