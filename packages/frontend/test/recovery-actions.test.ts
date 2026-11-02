import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecoveryNotice } from "../src/components/chat/RecoveryNotice";
import { useChatStore } from "../src/stores/chat";

afterEach(() => useChatStore.getState().reset());
test("recovery UI follows server actions, differentiates uncertain effects and clears obsolete actions", () => {
	useChatStore.getState().applyEvent({
		seq: 1,
		event: "run_issue",
		data: {
			issue: {
				issueId: "one",
				revision: 1,
				attemptId: "a",
				kind: "uncertain",
				message: "check result",
				createdAt: 1,
				allowedActions: ["continue", "abandon"],
			},
		},
	});
	const html = renderToStaticMarkup(
		createElement(RecoveryNotice, { issue: useChatStore.getState().issue }),
	);
	expect(html).toContain("已核对，继续");
	expect(html).toContain("放弃本轮");
	expect(html).not.toContain("重新执行工具");
	useChatStore.getState().applyEvent({ seq: 2, event: "run_issue", data: { issue: null } });
	expect(
		renderToStaticMarkup(createElement(RecoveryNotice, { issue: useChatStore.getState().issue })),
	).toBe("");
});
