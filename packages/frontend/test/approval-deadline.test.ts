import { afterEach, expect, test } from "bun:test";
import type { HistoryResponse, PendingRequest } from "@pi-agent/common";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionRequest } from "../src/components/chat/PermissionRequest";
import { useChatStore } from "../src/stores/chat";

afterEach(() => useChatStore.getState().reset());
test("restored approvals keep original absolute deadline and render timeout policy; settled history never restores them", () => {
	const request: PendingRequest = {
		requestId: "r",
		kind: "ask_question",
		createdAt: 1000,
		expiresAt: 301000,
		payload: { questions: [{ question: "which?", options: [] }] },
	};
	const h: HistoryResponse = {
		sessionId: "s",
		workspace: "w",
		status: "awaiting-approval",
		isCompacting: false,
		model: null,
		thinkingLevel: "off",
		availableThinkingLevels: ["off"],
		runMode: "safe",
		queue: { steering: [], followUp: [] },
		pendingApprovals: [request],
		messages: [],
		seq: 2,
	};
	useChatStore.getState().loadSnapshot(h);
	useChatStore.getState().reset();
	useChatStore.getState().loadSnapshot(h);
	const restored = useChatStore.getState().approvals.get("r")!;
	expect(restored.expiresAt).toBe(301000);
	const html = renderToStaticMarkup(
		createElement(PermissionRequest, { request: restored, onApprove: () => {} }),
	);
	expect(html).toContain("1970-01-01T00:05:01.000Z");
	expect(html).toContain("请自主决策");
	useChatStore.getState().applyEvent({
		seq: 3,
		event: "approval_settled",
		data: { requestId: "r", outcome: "answer", reason: "超时" },
	});
	expect(useChatStore.getState().approvals.size).toBe(0);
	useChatStore.getState().loadSnapshot({ ...h, seq: 3, pendingApprovals: [] });
	expect(useChatStore.getState().approvals.size).toBe(0);
	const permission: PendingRequest = {
		...request,
		kind: "tool_permission",
		payload: { toolName: "bash", input: { command: "x" }, runMode: "safe" },
	};
	expect(
		renderToStaticMarkup(
			createElement(PermissionRequest, { request: permission, onApprove: () => {} }),
		),
	).toContain("到期时的模式");
});
