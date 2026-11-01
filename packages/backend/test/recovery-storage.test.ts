import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalManager } from "../src/modules/agent/approval-manager";
import { SessionEventBus } from "../src/modules/agent/event-bus";
import { type RuntimeCheckpoint, RuntimeStore } from "../src/modules/agent/runtime-store";

test("runtime checkpoints survive reopening, remain owner scoped, and can be explicitly deleted", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-recovery-store-"));
	const checkpoint: RuntimeCheckpoint = {
		version: 1,
		userId: "u",
		username: "user",
		sessionId: "session",
		cwd: dir,
		active: true,
		inputs: [],
		approvals: [],
		tools: [],
	};
	try {
		let store = new RuntimeStore(join(dir, "runtime.sqlite"));
		store.write(checkpoint);
		store.close();
		store = new RuntimeStore(join(dir, "runtime.sqlite"));
		try {
			expect(store.read("u", "session")).toEqual(checkpoint);
			expect(store.read("other", "session")).toBeUndefined();
			expect(store.list()).toEqual([{ userId: "u", sessionId: "session" }]);
			store.write({ ...checkpoint, version: 2 } as unknown as RuntimeCheckpoint);
			expect(() => store.read("u", "session")).toThrow("检查点损坏");
			expect(store.list()).toEqual([{ userId: "u", sessionId: "session" }]);
			store.write({
				...checkpoint,
				tools: [{ toolCallId: "tool", name: "write", input: {}, phase: "completed" }],
			});
			expect(() => store.read("u", "session")).toThrow("检查点损坏");
			store.write(checkpoint);
			store.remove("u", "session");
			expect(store.read("u", "session")).toBeUndefined();
		} finally {
			store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restored approvals retain identity/deadline, settle durably before resolving and reject duplicates", async () => {
	const saved = new Map<
		string,
		{
			request: import("@pi-agent/common").PendingRequest;
			outcome?: import("../src/modules/agent/approval-manager").ApprovalOutcome;
		}
	>();
	const persistence = {
		find: (id: string) => saved.get(id),
		write: (
			request: import("@pi-agent/common").PendingRequest,
			outcome?: import("../src/modules/agent/approval-manager").ApprovalOutcome,
		) => {
			saved.set(request.requestId, structuredClone({ request, ...(outcome ? { outcome } : {}) }));
		},
	};
	const first = new ApprovalManager(new SessionEventBus(), persistence);
	void first.create(
		"tool_permission",
		"call",
		{ toolName: "write", input: { path: "x" }, runMode: "safe" },
		{ timeout: 1000 },
	);
	const original = structuredClone(first.pendingList()[0]!);
	first.suspend();
	const next = new ApprovalManager(new SessionEventBus(), persistence);
	const result = next.create("tool_permission", "call", original.payload, { timeout: 1000 });
	expect(next.pendingList()).toEqual([original]);
	expect(next.settle("call", { action: "allow" })).toBe(true);
	expect(saved.get("call")?.outcome).toEqual({ action: "allow" });
	expect(await result).toEqual({ allowed: true, reason: undefined });
	expect(next.settle("call", { action: "deny" })).toBe(false);
	const third = new ApprovalManager(new SessionEventBus(), persistence);
	expect(await third.create("tool_permission", "call", original.payload)).toEqual({
		allowed: true,
		reason: undefined,
	});
});

test("already expired restored questions use their original timeout and default answer", async () => {
	const request = {
		requestId: "ask",
		kind: "ask_question" as const,
		payload: { questions: [{ question: "Q", options: [] }] },
		createdAt: Date.now() - 301000,
		expiresAt: Date.now() - 1000,
	};
	const manager = new ApprovalManager(new SessionEventBus(), {
		find: () => ({ request }),
		write: () => {},
	});
	const result = manager.create("ask_question", "ask", request.payload, {
		timeout: 300000,
		onTimeout: () => ({ action: "answer", data: { answers: { Q: "请自主决策" }, timedOut: true } }),
	});
	expect(manager.pendingList()[0]?.expiresAt).toBe(request.expiresAt);
	expect(await result).toEqual({ answers: { Q: "请自主决策" }, timedOut: true });
});
