import { expect, test } from "bun:test";
import { ApprovalManager } from "../src/modules/agent/approval-manager";
import { SessionEventBus } from "../src/modules/agent/event-bus";
import { SessionUI } from "../src/modules/agent/session-ui";

test("declarative UI snapshots preserve newlines, replace keys, reject oversized data and flush final changes", () => {
	const bus = new SessionEventBus();
	const frames: unknown[] = [];
	bus.subscribe((event) => frames.push(event));
	const ui = new SessionUI(bus, new ApprovalManager(bus));
	try {
		ui.setStatus("test", "first");
		ui.setStatus("test", "second");
		ui.setWidget("lines", ["one", "two"]);
		expect(ui.snapshot.statuses.test).toBe("second");
		expect(ui.snapshot.widgets.lines?.lines).toEqual(["one", "two"]);
		expect(() => ui.setWidget("large", ["a".repeat(17000)])).toThrow();
		expect(ui.snapshot.widgets.large).toBeUndefined();
		ui.setStatus("test", undefined);
		ui.flush();
		expect(ui.snapshot.statuses.test).toBeUndefined();
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			event: "extension_ui",
			data: { statuses: {}, widgets: { lines: { lines: ["one", "two"] } } },
		});
	} finally {
		ui.dispose();
	}
});

test("an editor is one shared request with an independent draft and stable tool origin", async () => {
	const approvals = new ApprovalManager(new SessionEventBus());
	const ui = new SessionUI(new SessionEventBus(), approvals);
	try {
		const result = ui.withSource("call", () => ui.editor("Review", "original\ntext"));
		const request = approvals.pendingList()[0]!;
		expect(request.kind).toBe("ui_editor");
		expect(request.origin?.toolCallId).toBe("call");
		expect(request.payload).toMatchObject({ prefill: "original\ntext" });
		expect(approvals.settle(request.requestId, { action: "answer", data: "edited" })).toBe(true);
		expect(approvals.settle(request.requestId, { action: "answer", data: "duplicate" })).toBe(
			false,
		);
		expect(await result).toBe("edited");
	} finally {
		ui.dispose();
	}
});
