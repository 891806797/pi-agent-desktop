import { expect, mock } from "bun:test";
import type { WorkspaceInfo } from "@pi-agent/common";

const realReact = await import("react");

let slots: unknown[] = [];
let slot = 0;
let effects: Array<() => void> = [];
const useEffect = (fn: () => undefined | (() => void), deps: unknown[]) => {
	const index = slot++;
	const prior = slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
	if (prior && deps.every((d, i) => Object.is(d, prior.deps[i]))) return;
	effects.push(() => {
		prior?.cleanup?.();
		slots[index] = { deps, cleanup: fn() };
	});
};
const hooks = {
	useEffect,
	useRef: (initial: unknown) => {
		const index = slot++;
		if (!(index in slots)) slots[index] = { current: initial };
		return slots[index];
	},
	useState: (initial: unknown) => {
		const index = slot++;
		if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
		return [
			slots[index],
			(value: unknown) => {
				slots[index] = typeof value === "function" ? value(slots[index]) : value;
			},
		];
	},
	useCallback: (fn: unknown) => fn,
	useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
	useDebugValue() {},
};
mock.module("react", () => ({ ...realReact, ...hooks, default: { ...realReact, ...hooks } }));
const loc = { search: "?workspace=a&sessionId=A", pathname: "/chat" };
Object.defineProperty(globalThis, "location", { value: loc, configurable: true });
Object.defineProperty(globalThis, "window", {
	value: {
		innerWidth: 1200,
		location: loc,
		addEventListener() {},
		removeEventListener() {},
	},
	configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
	value: { getItem: () => null },
	configurable: true,
});
const navigations: string[] = [];
const navigate = (url: string) => {
	navigations.push(url);
	loc.search = new URL(url, "http://test").search;
};
mock.module("react-router-dom", () => ({ useLocation: () => loc, useNavigate: () => navigate }));
const projects: WorkspaceInfo[] = [
	{ encoded: "a", name: "A", path: "/a" },
	{ encoded: "b", name: "B", path: "/b" },
];
const pending = new Map<string, (value: unknown) => void>();
const realApi = await import("../../src/lib/api");
mock.module("../../src/lib/api", () => ({
	...realApi,
	listWorkspaces: async () => ({ workspaces: projects }),
	listSessions: (workspace: string) => new Promise((resolve) => pending.set(workspace, resolve)),
	listCatalog: (query: { workspace: string; limit?: number }) =>
		query.limit === 1
			? Promise.resolve({ sessions: [{ sessionId: `${query.workspace}_FIRST` }] })
			: new Promise((resolve) => pending.set(query.workspace, resolve)),
	addWorkspace: async () => ({}),
	logout: async () => ({}),
}));
const realChatAgent = await import("../../src/hooks/useChatAgent");
mock.module("../../src/hooks/useChatAgent", () => ({ ...realChatAgent, useChatAgent() {} }));
let agentWorkspace: unknown;
mock.module("../../src/hooks/useChatAgentApi", () => ({
	useChatAgentApi: (opts: { projectId: unknown }) => {
		agentWorkspace = opts.projectId;
		return {};
	},
}));
for (const [path, name] of [
	["../../src/components/chat/ChatMessageList", "ChatMessageList"],
	["../../src/components/layout/DirectoryPicker", "DirectoryPicker"],
	["../../src/components/layout/ResizeHandle", "ResizeHandle"],
] as const)
	mock.module(path, () => ({ [name]: () => null }));
function render(fn: () => unknown) {
	slot = 0;
	effects = [];
	const tree = fn();
	for (const effect of effects) effect();
	return tree;
}
interface ProbeProps {
	children?: unknown;
	onSelect?: (encoded: string) => void;
	onOpenSession?: (sid: string) => void;
	project?: WorkspaceInfo;
}
function find(node: unknown, property: keyof ProbeProps): ProbeProps | undefined {
	if (!node || typeof node !== "object") return;
	const element = node as { props?: ProbeProps };
	if (element.props?.[property]) return element.props;
	for (const child of [element.props?.children].flat(Infinity)) {
		const found = find(child, property);
		if (found) return found;
	}
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const { ChatPage } = await import("../../src/pages/ChatPage");
render(ChatPage);
await tick();
let tree = render(ChatPage);
find(tree, "onSelect")!.onSelect!("a");
expect(loc.search).toBe("?workspace=a&sessionId=A");
find(tree, "onSelect")!.onSelect!("b");
await tick();
expect(loc.search).toBe("?workspace=b&sessionId=b_FIRST");
loc.search = "?workspace=b&sessionId=B";
tree = render(ChatPage);
expect(agentWorkspace).toBe("b");
expect(find(tree, "onOpenSession")!.project!.encoded).toBe("b");
find(tree, "onOpenSession")!.onOpenSession!("B2");
expect(loc.search).toBe("?workspace=b&sessionId=B2");
const count = navigations.length;
await tick();
render(ChatPage);
expect(navigations.length).toBe(count);

// A late response from the old workspace must never become B's clickable sessions.
slots = [];
const { SidebarPanel } = await import("../../src/components/layout/SidebarPanel");
const sidebar = (project: WorkspaceInfo) =>
	SidebarPanel({ project, onOpenSession() {}, onNewSession() {} });
render(() => sidebar(projects[0]));
await new Promise((resolve) => setTimeout(resolve, 170));
render(() => sidebar(projects[1]));
await new Promise((resolve) => setTimeout(resolve, 170));
pending.get("b")!({ sessions: [{ sessionId: "B", firstMessage: "B_ONLY", live: true }] });
await tick();
expect(JSON.stringify(render(() => sidebar(projects[1])))).toContain("B_ONLY");
pending.get("a")!({ sessions: [{ sessionId: "A", firstMessage: "A_STALE", live: true }] });
await tick();
expect(JSON.stringify(render(() => sidebar(projects[1])))).not.toContain("A_STALE");
expect(JSON.stringify(render(() => sidebar(projects[1])))).toContain("B_ONLY");
