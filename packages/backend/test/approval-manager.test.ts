import { describe, expect, test } from "bun:test";
import type { SequencedEvent } from "@pi-agent/common";
import { ApprovalManager, requestToolPermission } from "../src/modules/agent/approval-manager";
import { SessionEventBus } from "../src/modules/agent/event-bus";

describe("ApprovalManager lifecycle", () => {
	test("cancellation clears every tab and resolves input without an answer", async () => {
		const bus = new SessionEventBus();
		const events: SequencedEvent[] = [];
		bus.subscribe((event) => events.push(event));
		const approvals = new ApprovalManager(bus);
		const answer = approvals.create("ui_input", "input", { title: "name" });
		approvals.rejectAll("abort");
		expect(await answer).toBeUndefined();
		expect(approvals.pendingList()).toEqual([]);
		expect(events.filter((e) => e.event === "approval_settled")).toHaveLength(1);
		expect(approvals.settle("input", { action: "answer", data: "late" })).toBe(false);
	});

	test("pending count controls status and restores the latest business status", async () => {
		const bus = new SessionEventBus();
		const statuses: string[] = [];
		const approvals = new ApprovalManager(bus);
		bus.subscribe((event) => {
			if (event.event === "status") statuses.push(event.data.status);
		});
		bus.publish({ event: "status", data: { status: "tool-use" } });
		const first = approvals.create("ui_input", "a", { title: "a" });
		const second = approvals.create("ui_input", "b", { title: "b" });
		expect(statuses.at(-1)).toBe("awaiting-approval");
		approvals.settle("a", { action: "answer", data: "a" });
		expect(statuses.at(-1)).toBe("awaiting-approval");
		bus.publish({ event: "status", data: { status: "error" } });
		approvals.settle("b", { action: "answer", data: "b" });
		await Promise.all([first, second]);
		expect(statuses.at(-1)).toBe("error");
	});

	test("signal and timeout settle requests and a late signal cannot settle twice", async () => {
		const bus = new SessionEventBus();
		const approvals = new ApprovalManager(bus);
		const controller = new AbortController();
		const aborted = approvals.create(
			"ui_input",
			"a",
			{ title: "a" },
			{ signal: controller.signal },
		);
		controller.abort();
		expect(await aborted).toBeUndefined();
		const timed = approvals.create("ui_input", "b", { title: "b" }, { timeout: 1 });
		expect(await timed).toBeUndefined();
		const answered = approvals.create(
			"ui_input",
			"c",
			{ title: "c" },
			{ signal: controller.signal },
		);
		expect(await answered).toBeUndefined();
		expect(approvals.pendingList()).toEqual([]);
	});

	test("permission actions always resolve with an explicit decision", async () => {
		const approvals = new ApprovalManager(new SessionEventBus());
		const allowed = requestToolPermission(approvals, "allow", "write", {}, "safe");
		approvals.settle("allow", { action: "allow" });
		expect(await allowed).toEqual({ allowed: true, reason: undefined });
		const denied = requestToolPermission(approvals, "deny", "write", {}, "safe");
		approvals.rejectAll("closed");
		expect(await denied).toEqual({ allowed: false, reason: "closed" });
	});
});
