import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { ApprovalManager } from "../src/modules/agent/approval-manager";
import { SessionEventBus } from "../src/modules/agent/event-bus";
import { makeRunModeGateExt, RunModeHolder } from "../src/modules/agent/ext-run-mode-gate";

test("等待审批时切到plan，旧的允许动作不能继续写入", async () => {
	const approvals = new ApprovalManager(new SessionEventBus());
	const mode = new RunModeHolder("safe");
	let handler!: (event: unknown) => Promise<ToolCallEventResult | undefined>;
	makeRunModeGateExt(
		mode,
		approvals,
	)({
		on: (_name: string, callback: typeof handler) => {
			handler = callback;
		},
	} as unknown as ExtensionAPI);
	const result = handler({
		toolName: "write",
		toolCallId: "write",
		input: { path: "a", content: "b" },
	});
	mode.set("plan");
	approvals.settle("write", { action: "allow" });
	expect(await result).toMatchObject({ block: true });
});
