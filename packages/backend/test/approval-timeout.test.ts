import { afterEach, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunMode, SequencedEvent } from "@pi-agent/common";
import { getHistory } from "../src/modules/agent/agent.service";
import { ApprovalManager, requestToolPermission } from "../src/modules/agent/approval-manager";
import { SessionEventBus } from "../src/modules/agent/event-bus";
import { EventTranslator } from "../src/modules/agent/event-translator";
import { makeAskQuestionExt } from "../src/modules/agent/ext-ask-question";
import { makeRunModeGateExt, RunModeHolder } from "../src/modules/agent/ext-run-mode-gate";
import type { SessionContext } from "../src/modules/agent/session-registry";

const realSet = globalThis.setTimeout,
	realClear = globalThis.clearTimeout;
let now = 1000,
	id = 0;
const timers = new Map<number, { due: number; run: () => void }>();
let nowSpy: ReturnType<typeof spyOn>;
function fakeTime() {
	now = 1000;
	id = 0;
	timers.clear();
	nowSpy = spyOn(Date, "now").mockImplementation(() => now);
	globalThis.setTimeout = ((run: () => void, ms = 0) => {
		timers.set(++id, { due: now + ms, run });
		return id;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((id: number) => {
		timers.delete(id);
	}) as typeof clearTimeout;
}
function advance(ms: number) {
	now += ms;
	for (const [id, timer] of [...timers])
		if (timer.due <= now) {
			timers.delete(id);
			timer.run();
		}
}
afterEach(() => {
	globalThis.setTimeout = realSet;
	globalThis.clearTimeout = realClear;
	nowSpy?.mockRestore();
	timers.clear();
});

test("timeout persistence failure keeps approval pending and retries without terminating the process", async () => {
	fakeTime();
	let fail = true;
	const bus = new SessionEventBus();
	const events: SequencedEvent[] = [];
	bus.subscribe((event) => events.push(event));
	const manager = new ApprovalManager(bus, {
		find: () => undefined,
		write: (_request, outcome) => {
			if (outcome && fail) throw new Error("database busy");
		},
	});
	const result = requestToolPermission(manager, "write", "write", {}, "auto");
	expect(() => advance(300000)).not.toThrow();
	expect(manager.pendingList()).toHaveLength(1);
	expect(events.filter((e) => e.event === "approval_settled")).toEqual([]);
	expect(events.some((e) => e.event === "error")).toBe(true);
	fail = false;
	advance(1000);
	expect(await result).toMatchObject({ allowed: true });
	expect(manager.pendingList()).toEqual([]);
});
test("permission deadline survives page absence and reads current mode at five minutes, broadcasts once to all tabs", async () => {
	fakeTime();
	for (const initial of ["safe", "standard"] as const)
		for (const current of ["safe", "standard", "auto", "plan"] as const) {
			const bus = new SessionEventBus();
			const tabs: [SequencedEvent[], SequencedEvent[]] = [[], []];
			for (const tab of tabs) bus.subscribe((e) => tab.push(e));
			const manager = new ApprovalManager(bus);
			let mode: RunMode = initial;
			const answer = requestToolPermission(manager, "p", "bash", {}, () => mode);
			const pending = manager.pendingList()[0]!;
			expect(pending.expiresAt).toBe(now + 300000);
			advance(299999);
			expect(manager.pendingList()[0]?.expiresAt).toBe(pending.expiresAt);
			mode = current;
			advance(1);
			expect(await answer).toMatchObject({ allowed: current !== "safe" });
			expect(manager.pendingList()).toEqual([]);
			expect(manager.settle("p", { action: "allow" })).toBe(false);
			for (const tab of tabs) {
				const settled = tab.filter((e) => e.event === "approval_settled");
				expect(settled).toHaveLength(1);
				expect(settled[0]?.data).toMatchObject({ outcome: current === "safe" ? "deny" : "allow" });
				expect(settled[0]?.event === "approval_settled" && settled[0].data.reason).toContain(
					"超时",
				);
			}
			expect(timers.size).toBe(0);
		}
});
test("user click/timeout/abort races settle once and remove deadline timer", async () => {
	fakeTime();
	for (const winner of ["click", "timeout", "abort"]) {
		const events: SequencedEvent[] = [];
		const bus = new SessionEventBus();
		bus.subscribe((e) => events.push(e));
		const manager = new ApprovalManager(bus);
		const signal = new AbortController();
		const p = manager.create(
			"ui_input",
			"p",
			{ title: "input" },
			{ timeout: 300000, signal: signal.signal },
		);
		const staleTimer = [...timers.values()][0]!.run;
		if (winner === "click") manager.settle("p", { action: "answer", data: "typed" });
		if (winner === "abort") signal.abort();
		if (winner === "timeout") advance(300000);
		staleTimer();
		signal.abort();
		manager.settle("p", { action: "answer", data: "late" });
		expect(await p).toBe(winner === "click" ? "typed" : undefined);
		expect(events.filter((e) => e.event === "approval_settled")).toHaveLength(1);
		expect(manager.pendingList()).toEqual([]);
		expect(timers.size).toBe(0);
	}
});
test("ask timeout returns system autonomous answers for every question even when custom options are forbidden", async () => {
	fakeTime();
	const manager = new ApprovalManager(new SessionEventBus());
	let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
	makeAskQuestionExt(manager)({
		registerTool: (definition: typeof tool) => {
			tool = definition;
		},
	} as ExtensionAPI);
	const result = tool.execute(
		"ask",
		{
			questions: [
				{ question: "Q1", options: [{ label: "A" }], allowCustom: false },
				{ question: "Q2", options: [], required: false },
			],
		},
		undefined,
		undefined,
		{} as never,
	);
	expect(manager.pendingList()[0]?.expiresAt).toBe(now + 300000);
	advance(300000);
	const output = await result;
	expect(output.isError).toBe(false);
	expect(output.details).toMatchObject({ answers: { Q1: "请自主决策", Q2: "请自主决策" } });
	expect(output.content).toMatchObject([{ text: expect.stringContaining("系统超时") }]);
	expect(manager.pendingList()).toEqual([]);
	expect(timers.size).toBe(0);
});
test("permission timeout in plan still cannot execute a write", async () => {
	fakeTime();
	const manager = new ApprovalManager(new SessionEventBus());
	const mode = new RunModeHolder("safe");
	let handler!: (event: unknown) => Promise<unknown>;
	makeRunModeGateExt(
		mode,
		manager,
	)({
		on: (_name: string, cb: typeof handler) => {
			handler = cb;
		},
	} as unknown as ExtensionAPI);
	const result = handler({
		toolName: "write",
		toolCallId: "p",
		input: { path: "a", content: "b" },
	});
	mode.set("plan");
	advance(300000);
	expect(await result).toMatchObject({ block: true });
	expect(timers.size).toBe(0);
});

test("returning history replays original permission and ask deadlines, and an expired request cannot reappear", async () => {
	fakeTime();
	const bus = new SessionEventBus();
	const manager = new ApprovalManager(bus);
	let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
	makeAskQuestionExt(manager)({
		registerTool: (definition: typeof tool) => {
			tool = definition;
		},
	} as ExtensionAPI);
	const permission = requestToolPermission(manager, "permission", "bash", {}, "safe");
	const ask = tool.execute(
		"question",
		{ questions: [{ question: "Q", options: [] }] },
		undefined,
		undefined,
		{} as never,
	);
	const ctx = {
		sessionId: "s",
		cwd: "D:/workspace",
		status: "tool-use",
		approvals: manager,
		bus,
		translator: new EventTranslator(),
		runMode: new RunModeHolder("safe"),
		session: {
			getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
			sessionManager: { getEntries: () => [] },
			messages: [],
			state: {},
			isCompacting: false,
			thinkingLevel: "off",
			getAvailableThinkingLevels: () => ["off"],
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
		},
	} as unknown as SessionContext;
	const first = getHistory(ctx);
	expect(first.pendingApprovals.map((r) => r.expiresAt)).toEqual([301000, 301000]);
	advance(200000);
	const returned = getHistory(ctx);
	expect(returned.status).toBe("awaiting-approval");
	expect(returned.pendingApprovals.map((r) => r.expiresAt)).toEqual([301000, 301000]);
	advance(100000);
	expect(await permission).toMatchObject({ allowed: false });
	expect((await ask).isError).toBe(false);
	expect(getHistory(ctx).pendingApprovals).toEqual([]);
	expect(manager.settle("question", { action: "answer", data: { answers: { Q: "late" } } })).toBe(
		false,
	);
	expect(getHistory(ctx).pendingApprovals).toEqual([]);
	expect(timers.size).toBe(0);
});
