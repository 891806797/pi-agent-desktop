import { expect, mock } from "bun:test";
import type { HistoryResponse } from "@pi-agent/common";

const react = await import("react");
let cleanup: (() => void) | undefined;
let deps: unknown[] = [];
mock.module("react", () => ({
	...react,
	useEffect: (fn: () => (() => void) | undefined, next: unknown[]) => {
		if (next.every((value, index) => value === deps[index])) return;
		cleanup?.();
		deps = next;
		cleanup = fn();
	},
}));
const loc = { search: "?workspace=w&sessionId=A", pathname: "/chat" };
Object.defineProperty(globalThis, "location", { value: loc, configurable: true });
Object.defineProperty(globalThis, "window", {
	value: { addEventListener() {}, removeEventListener() {} },
	configurable: true,
});
const navigations: string[] = [];
const navigate = (url: string) => {
	navigations.push(url);
};
mock.module("react-router-dom", () => ({ useLocation: () => loc, useNavigate: () => navigate }));
const pending = new Map<string, (response: Response) => void>();
const requests: string[] = [];
globalThis.fetch = (url, init) => {
	if (url === "/api/settings/defaults")
		return Promise.resolve(
			Response.json({ ok: true, data: { model: null, thinkingLevel: "off", runMode: "standard" } }),
		);
	const sid = new Headers(init?.headers).get("x-session-id") ?? "";
	requests.push(String(url));
	return new Promise((resolve) => pending.set(sid, resolve));
};
class Source {
	static instances: Source[] = [];
	listeners = new Map<string, (e: unknown) => void>();
	closed = false;
	constructor(public url: string) {
		Source.instances.push(this);
	}
	addEventListener(name: string, fn: (e: unknown) => void) {
		this.listeners.set(name, fn);
	}
	close() {
		this.closed = true;
	}
	emit(name: string, data: unknown, seq: number) {
		this.listeners.get(name)?.({ data: JSON.stringify(data), lastEventId: String(seq) });
	}
}
Object.defineProperty(globalThis, "EventSource", { value: Source, configurable: true });
const { useChatStore } = await import("../../src/stores/chat");
const { useChatAgent: renderAgent } = await import("../../src/hooks/useChatAgent");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const snapshot = (sid: string): HistoryResponse => ({
	sessionId: sid,
	workspace: "w",
	messages: [
		{ type: "assistant", id: sid, blocks: [{ kind: "thinking", thinking: sid }], createdAt: 0 },
	],
	seq: 3,
	status: "thinking",
	isCompacting: false,
	model: null,
	thinkingLevel: "high",
	availableThinkingLevels: ["off", "high"],
	runMode: "safe",
	queue: { steering: [], followUp: [sid] },
	pendingApprovals: [{ requestId: sid, kind: "ui_input", payload: { title: sid }, createdAt: 0 }],
});
const resolveSnapshot = (sid: string) =>
	pending.get(sid)!(Response.json({ ok: true, data: snapshot(sid) }));
renderAgent();
cleanup?.();
deps = [];
renderAgent();
await Promise.resolve();
expect(requests).toEqual(["/api/session/messages"]);
resolveSnapshot("A");
await tick();
expect(useChatStore.getState().sessionId).toBe("A");
const a = Source.instances[0];
loc.search = "?workspace=w&sessionId=B";
renderAgent();
await Promise.resolve();
expect(a.closed).toBe(true);
expect(useChatStore.getState().messages).toEqual([]);
expect(useChatStore.getState().approvals.size).toBe(0);
expect(useChatStore.getState().queue.followUp).toEqual([]);
expect(useChatStore.getState().isSwitchingSession).toBe(true);
a.emit("status", { status: "responding" }, 4);
a.emit("approval_request", snapshot("A").pendingApprovals[0], 5);
expect(useChatStore.getState().status).toBe("idle");
expect(useChatStore.getState().approvals.size).toBe(0);
loc.search = "?workspace=w&sessionId=C";
renderAgent();
await Promise.resolve();
resolveSnapshot("C");
await tick();
resolveSnapshot("B");
await tick();
expect(useChatStore.getState().sessionId).toBe("C");
expect(useChatStore.getState().queue.followUp).toEqual(["C"]);
expect(Source.instances).toHaveLength(2);
loc.search = "?workspace=other";
renderAgent();
expect(Source.instances[1].closed).toBe(true);
expect(useChatStore.getState().messages).toEqual([]);
expect(useChatStore.getState().sessionId).toBeNull();
expect(navigations).toEqual([]);
expect(requests.every((path) => path === "/api/session/messages")).toBe(true);

// 首次登录没有项目时留在聊天页，不能被送进模型配置页形成跳转循环。
loc.search = "";
renderAgent();
pending.get("")!(Response.json({ ok: true, data: { workspaces: [] } }));
await tick();
expect(navigations).toEqual([]);

// 已有项目时仍沿用默认项目，空会话不触发模型或历史恢复。
loc.search = "?workspace=other";
renderAgent();
loc.search = "";
renderAgent();
pending.get("")!(Response.json({ ok: true, data: { workspaces: [{ encoded: "first" }] } }));
await tick();
pending.get("")!(Response.json({ ok: true, data: { sessions: [{ sessionId: "FIRST" }] } }));
await tick();
expect(navigations).toEqual(["/chat?workspace=first&sessionId=FIRST"]);
cleanup?.();
