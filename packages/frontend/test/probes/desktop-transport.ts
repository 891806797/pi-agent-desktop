import { expect, mock } from "bun:test";
import type { DesktopStreamFrame } from "@pi-agent/common";

let native = true;
let nextResponse = {
	status: 403,
	body: JSON.stringify({ ok: false, code: "FORBIDDEN", message: "denied" }),
};
const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
const channels: FakeChannel[] = [];
let acknowledge: (() => void) | undefined;
class FakeChannel {
	onmessage: (frame: DesktopStreamFrame) => void;
	constructor(onmessage: (frame: DesktopStreamFrame) => void) {
		this.onmessage = onmessage;
		channels.push(this);
	}
}
mock.module("@tauri-apps/api/core", () => ({
	isTauri: () => native,
	Channel: FakeChannel,
	invoke: async (command: string, args: Record<string, unknown>) => {
		calls.push({ command, args });
		if (command === "backend_request") return nextResponse;
		if (command === "backend_subscribe")
			await new Promise<void>((resolve) => {
				acknowledge = resolve;
			});
	},
}));
Object.assign(globalThis, { window: new EventTarget() });
const desktop = await import("../../src/lib/desktop").catch(() => null);
expect(desktop).not.toBeNull();
if (!desktop) throw new Error("desktop transport is not implemented");
expect(desktop.isDesktop()).toBe(true);
Object.assign(globalThis, { document: { visibilityState: "visible", hasFocus: () => true } });
expect(typeof desktop.setDesktopVisibility).toBe("function");
expect(desktop.isPageVisible()).toBe(false);
desktop.setDesktopVisibility(true);
expect(desktop.isPageVisible()).toBe(true);
desktop.setDesktopNavigationPending(true);
expect(desktop.isPageVisible()).toBe(false);
desktop.setDesktopNavigationPending(false);
expect(desktop.isPageVisible()).toBe(true);
desktop.setDesktopVisibility(false);
expect(desktop.isPageVisible()).toBe(false);
const response = await desktop.desktopFetch("/api/session/messages", {
	method: "POST",
	headers: { "x-session-id": "one" },
	body: JSON.stringify({ text: "hello" }),
});
expect(response.status).toBe(403);
expect(await response.json()).toEqual({ ok: false, code: "FORBIDDEN", message: "denied" });
expect(calls[0]).toEqual({
	command: "backend_request",
	args: {
		request: {
			path: "/api/session/messages",
			method: "POST",
			headers: { "x-session-id": "one" },
			body: '{"text":"hello"}',
		},
	},
});
nextResponse = { status: 200, body: '{"ok":true,"data":{"models":[]}}' };
expect((await desktop.desktopFetch("/api/models")).status).toBe(200);

const source = desktop.openDesktopEventSource("/api/sessions/one/events?sinceSeq=7");
const frames: string[] = [];
let opened = 0;
source.onopen = () => {
	opened++;
};
source.addEventListener("text_chunk", (event) => frames.push((event as MessageEvent).data));
channels[0]!.onmessage({ name: "open" });
channels[0]!.onmessage({ name: "text_chunk", data: '{"text":"中文\\n尾部"}', lastEventId: "8" });
expect(opened).toBe(1);
expect(frames).toEqual(['{"text":"中文\\n尾部"}']);
source.close();
channels[0]!.onmessage({ name: "text_chunk", data: "late", lastEventId: "9" });
expect(frames).toHaveLength(1);
acknowledge!();
await new Promise((resolve) => setTimeout(resolve, 0));
expect(
	calls.filter((call) => call.command === "backend_unsubscribe").length,
).toBeGreaterThanOrEqual(1);
const openCall = calls.find((call) => call.command === "backend_subscribe")!;
expect(
	calls
		.filter((call) => call.command === "backend_unsubscribe")
		.every((call) => call.args.id === openCall.args.id),
).toBe(true);
source.close();

const errors: Event[] = [];
const failing = desktop.openDesktopEventSource("/api/user/events?epoch=e&sinceSeq=1");
failing.addEventListener("error", (event) => errors.push(event));
channels[1]!.onmessage({
	name: "error",
	data: null,
	lastEventId: null,
} as unknown as DesktopStreamFrame);
expect(errors).toHaveLength(1);
expect((errors[0] as MessageEvent).data).toBeUndefined();
failing.close();
acknowledge!();
await new Promise((resolve) => setTimeout(resolve, 0));
const { ChatSseClient } = await import("../../src/lib/sse-client");
let resyncs = 0;
const businessEvents: unknown[] = [];
const client = new ChatSseClient(
	"one",
	"workspace",
	{
		onEvent: (event) => businessEvents.push(event),
		onResync: () => {
			resyncs++;
		},
	},
	7,
	"epoch",
);
client.start();
channels[2]!.onmessage({
	name: "error",
	data: null,
	lastEventId: null,
} as unknown as DesktopStreamFrame);
expect(resyncs).toBe(1);
expect(businessEvents).toEqual([]);
acknowledge!();
client.stop();
await new Promise((resolve) => setTimeout(resolve, 0));
native = false;
expect(desktop.isDesktop()).toBe(false);
