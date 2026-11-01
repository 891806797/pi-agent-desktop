import { expect, test } from "bun:test";
import type { ChatMessage, PendingRequest } from "@pi-agent/common";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Messages from "../src/components/chat/ChatMessageList";
import { PermissionRequest } from "../src/components/chat/PermissionRequest";
import { ToolResultRenderer } from "../src/components/chat/tool-results";

test("assistant consumes the common pi blocks directly, including tool status and result", () => {
	const message: Extract<ChatMessage, { type: "assistant" }> = {
		id: "a",
		type: "assistant",
		createdAt: 1,
		blocks: [
			{ kind: "text", text: "直接显示" },
			{
				kind: "toolCall",
				toolCallId: "t",
				name: "bash",
				argsText: '{"command":"pwd"}',
				status: "done",
				result: { content: "fixture-output" },
			},
		],
	};
	const html = renderToStaticMarkup(createElement(Messages.AssistantBubble, { message }));
	expect(html).toContain("直接显示");
	expect(html).toContain("fixture-output");
});

test("plain user text resembling another framework's XML remains visible and offers no fake rewind", () => {
	const message: Extract<ChatMessage, { type: "user" }> = {
		id: "u",
		type: "user",
		createdAt: 1,
		content: "<local-command-caveat>用户自己的原文</local-command-caveat>",
	};
	const html = renderToStaticMarkup(createElement(Messages.UserBubble, { message }));
	expect(html).toContain("用户自己的原文");
	expect(html).toContain("&lt;local-command-caveat&gt;");
	expect(html).not.toContain("回滚");
});

test("permission cards consume the shared pending request payload without name or boolean adapters", () => {
	const request: PendingRequest = {
		requestId: "r",
		kind: "tool_permission",
		createdAt: 1,
		expiresAt: 300001,
		payload: { toolName: "bash", input: { command: "fixture-command" }, runMode: "safe" },
	};
	const html = renderToStaticMarkup(
		createElement(PermissionRequest, { request, onApprove: () => {} }),
	);
	expect(html).toContain("fixture-command");
	expect(html).toContain("1970-01-01T00:05:00.001Z");
});

test("tool text is not interpreted as Claude system-reminder metadata", () => {
	const html = renderToStaticMarkup(
		createElement(ToolResultRenderer, {
			content: "<system-reminder>文件的真实内容</system-reminder>",
		}),
	);
	expect(html).toContain("文件的真实内容");
});

test("plain tool output preserves source lines instead of interpreting Markdown syntax", () => {
	const html = renderToStaticMarkup(
		createElement(ToolResultRenderer, { content: "# source heading\nline two" }),
	);
	expect(html).toContain("<pre");
	expect(html).toContain("# source heading\nline two");
	expect(html).not.toContain("<h1");
});

test("native reply truncation, response usage and tool details are visible", () => {
	const html = renderToStaticMarkup(
		createElement(Messages.AssistantBubble, {
			message: {
				id: "a",
				type: "assistant",
				createdAt: 1,
				stopReason: "length",
				usage: { inputTokens: 123, outputTokens: 45, cacheReadTokens: 0, cacheCreationTokens: 0 },
				blocks: [
					{
						kind: "toolCall",
						toolCallId: "t",
						name: "edit",
						argsText: "{}",
						status: "error",
						result: { content: "edited", toolUseResult: { diff: "-old\n+new" }, durationMs: 42 },
					},
				],
			},
		}),
	);
	expect(html).toContain("达到输出长度限制");
	expect(html).toContain("本次响应");
	expect(html).toContain("123");
	expect(html).toContain("+new");
});

test("image-only user messages remain visible", () => {
	const html = renderToStaticMarkup(
		createElement(Messages.UserBubble, {
			message: {
				id: "u",
				type: "user",
				content: "",
				createdAt: 1,
				images: [{ type: "image", data: "fixture", mimeType: "image/png" }],
			},
		}),
	);
	expect(html).toContain("data:image/png;base64,fixture");
});
