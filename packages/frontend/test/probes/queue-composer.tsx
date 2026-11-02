import { expect, mock } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const snapshot = {
	queue: { steering: [] as string[], followUp: [] as string[], revision: 1 },
	issue: undefined as unknown,
};
mock.module("../../src/stores/chat", () => ({
	useChatStore: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
}));
const { QueueBar } = await import("../../src/components/input/QueueBar");
const render = () => renderToStaticMarkup(createElement(QueueBar));

snapshot.queue.steering = ["已直接发送的消息"];
expect(render()).toBe("");
snapshot.queue.followUp = ["任务结束后发送的消息"];
const queued = render();
expect(queued).toContain("任务结束后发送的消息");
expect(queued).not.toContain("已直接发送的消息");
expect((queued.match(/<button/g) ?? []).length).toBe(2);
expect(queued).toContain("直接发送");
expect(queued).toContain("删除这条待消息");
snapshot.issue = { kind: "recovery" };
expect(render()).toContain("已直接发送的消息");
