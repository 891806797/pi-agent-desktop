import { expect, mock } from "bun:test";

let slot = 0;
const slots: unknown[] = [];
const hooks = {
	useRef: <T>(value: T): { current: T } => {
		const i = slot++;
		if (!(i in slots)) slots[i] = { current: value };
		return slots[i] as { current: T };
	},
	useState: <T>(value: T): [T, (value: T) => void] => {
		const i = slot++;
		if (!(i in slots)) slots[i] = value;
		return [
			slots[i] as T,
			(next: T) => {
				slots[i] = next;
			},
		];
	},
	useCallback: <T>(callback: T) => callback,
	useMemo: <T>(fn: () => T) => fn(),
	useEffect: () => {},
	useSyncExternalStore: <T>(_subscribe: unknown, snapshot: () => T) => snapshot(),
	useDebugValue: () => {},
};
mock.module("react", () => ({ ...hooks, default: hooks }));
const loc = { search: "?workspace=w&sessionId=A", pathname: "/chat" };
const routerLoc = { ...loc };
Object.defineProperty(globalThis, "location", { value: loc, configurable: true });
mock.module("react-router-dom", () => ({
	useLocation: () => routerLoc,
	useNavigate: () => (url: string) => {
		loc.search = new URL(url, "http://test").search;
	},
}));
const sent: string[] = [];
const responses = new Map<string, (response: Response) => void>();
let creates = 0;
let modeAttempts = 0;
globalThis.fetch = (url, init) => {
	if (url === "/api/settings/defaults")
		return Promise.resolve(
			Response.json({ ok: true, data: { model: null, thinkingLevel: "off", runMode: "safe" } }),
		);
	if (url === "/api/session/thinking")
		return Promise.resolve(Response.json({ ok: true, data: {} }));
	if (url === "/api/sessions") {
		creates++;
		return Promise.resolve(Response.json({ ok: true, data: { sessionId: "created", live: true } }));
	}
	if (url === "/api/session/run-mode") {
		modeAttempts++;
		return modeAttempts === 1
			? Promise.reject(Error("mode failed"))
			: Promise.resolve(Response.json({ ok: true, data: {} }));
	}
	const headers = init?.headers as Record<string, string>;
	const sid = headers["x-session-id"];
	sent.push(sid);
	return new Promise<Response>((resolve) => responses.set(sid, resolve));
};
const { useChatAgentApi: renderAgent } = await import("../../src/hooks/useChatAgentApi");
const render = () => {
	slot = 0;
	return renderAgent({ projectId: "w" });
};
const a = render();
const acceptedA = a.sendMessage("A pending");
expect(acceptedA).toBeInstanceOf(Promise);
let settledA = false;
void acceptedA.then(() => {
	settledA = true;
});
expect(settledA).toBe(false);
await new Promise((resolve) => setTimeout(resolve, 0));
loc.search = "?workspace=w&sessionId=B";
routerLoc.search = loc.search;
let b = render();
const acceptedB = b.sendMessage("B pending");
expect(acceptedB).toBeInstanceOf(Promise);
await new Promise((resolve) => setTimeout(resolve, 0));
expect(sent).toEqual(["A", "B"]);
expect(await b.sendMessage("duplicate B")).toBe(false);
responses.get("A")!(Response.json({ ok: true, data: { queued: false } }));
await new Promise((resolve) => setTimeout(resolve, 0));
expect(await acceptedA).toBe(false);
b = render();
expect(await b.sendMessage("B still pending")).toBe(false);
responses.get("B")!(Response.json({ ok: true, data: { queued: false } }));
await new Promise((resolve) => setTimeout(resolve, 0));
expect(await acceptedB).toBe(true);
b = render();
const acceptedAgain = b.sendMessage("B accepted again");
expect(acceptedAgain).toBeInstanceOf(Promise);
await new Promise((resolve) => setTimeout(resolve, 0));
expect(sent).toEqual(["A", "B", "B"]);

loc.search = "?workspace=w";
routerLoc.search = loc.search;
let created = render();
expect(await created.sendMessage("new first")).toBe(false);
await new Promise((resolve) => setTimeout(resolve, 0));
expect(loc.search).toBe("?workspace=w&sessionId=created");
created = render();
expect(created.lastError).toBe("mode failed");
const retry = created.sendMessage("retry same session");
expect(retry).toBeInstanceOf(Promise);
expect(creates).toBe(1);
await new Promise((resolve) => setTimeout(resolve, 0));
expect(sent.at(-1)).toBe("created");

// Keep the router on its old render while window.history has already navigated.
slots.length = 0;
loc.search = "?workspace=w";
routerLoc.search = loc.search;
sent.length = 0;
let resolveMode!: (r: Response) => void;
globalThis.fetch = (url, init) => {
	if (url === "/api/settings/defaults")
		return Promise.resolve(
			Response.json({ ok: true, data: { model: null, thinkingLevel: "off", runMode: "safe" } }),
		);
	if (url === "/api/session/thinking")
		return Promise.resolve(Response.json({ ok: true, data: {} }));
	if (url === "/api/sessions")
		return Promise.resolve(Response.json({ ok: true, data: { sessionId: "delayed", live: true } }));
	if (url === "/api/session/run-mode")
		return new Promise((resolve) => {
			resolveMode = resolve;
		});
	const sid = new Headers(init?.headers).get("x-session-id")!;
	sent.push(sid);
	return Promise.resolve(Response.json({ ok: true, data: { queued: false } }));
};
render().sendMessage("first delayed transition");
await new Promise((resolve) => setTimeout(resolve, 0));
render();
routerLoc.search = loc.search;
render();
resolveMode(Response.json({ ok: true, data: {} }));
await new Promise((resolve) => setTimeout(resolve, 0));
expect(sent).toEqual(["delayed"]);

// A detached approval card cannot use B's URL even if both models reuse the same tool call ID.
const { useChatStore } = await import("../../src/stores/chat");
slots.length = 0;
loc.search = "?workspace=w&sessionId=A";
routerLoc.search = loc.search;
useChatStore.setState({
	sessionId: "A",
	approvals: new Map([
		[
			"shared-call",
			{
				requestId: "shared-call",
				kind: "tool_permission",
				payload: { toolName: "write", input: {}, runMode: "safe" },
				createdAt: 0,
			},
		],
	]),
});
const old = render();
loc.search = "?workspace=w&sessionId=B";
useChatStore.setState({ sessionId: "B" });
let staleRequests = 0;
globalThis.fetch = async () => {
	staleRequests++;
	return Response.json({ ok: true, data: {} });
};
await old.approve("shared-call", "allow");
await old.selectRunMode("auto");
expect(staleRequests).toBe(0);

// The same URL under a different account must not revive a waiting send.
const { useAuthStore } = await import("../../src/stores/auth");
const { applyInitialPreferences } = await import("../../src/lib/default-settings");
slots.length = 0;
loc.search = "?workspace=w";
routerLoc.search = loc.search;
useAuthStore.setState({ username: "original" });
useChatStore.setState({ sessionId: null });
let releasePreferences!: () => void;
const preferenceGate = applyInitialPreferences(
	() =>
		new Promise<void>((resolve) => {
			releasePreferences = resolve;
		}),
);
await new Promise((resolve) => setTimeout(resolve, 0));
const waitingSend = render().sendMessage("belongs to original");
useAuthStore.setState({ username: "different" });
releasePreferences();
await preferenceGate;
expect(await waitingSend).toBe(false);
expect(staleRequests).toBe(0);
expect(loc.search).toBe("?workspace=w");

slots.length = 0;
loc.search = "?workspace=w";
routerLoc.search = loc.search;
useChatStore.setState({ sessionId: null });
expect(render().commands.map((command) => command.name)).toEqual(["new", "compact"]);

slots.length = 0;
loc.search = "?workspace=w&sessionId=B";
routerLoc.search = loc.search;
const commandAgent = render();
expect(await commandAgent.sendMessage("/new")).toBe(true);
expect(loc.search).toBe("?workspace=w");
expect(staleRequests).toBe(0);
