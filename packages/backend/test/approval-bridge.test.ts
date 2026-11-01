import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ApprovalManager } from "../src/modules/agent/approval-manager";
import { judgeToolCall } from "../src/modules/agent/dangerous-commands";
import { SessionEventBus } from "../src/modules/agent/event-bus";
import { makeAskQuestionExt } from "../src/modules/agent/ext-ask-question";
import { makeWebUIContext } from "../src/modules/agent/ui-context";

function setup() {
	const approvals = new ApprovalManager(new SessionEventBus());
	let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
	makeAskQuestionExt(approvals)({
		registerTool: (definition: typeof tool) => {
			tool = definition;
		},
	} as ExtensionAPI);
	return { approvals, tool };
}

describe("Web approval bridges", () => {
	test("confirm accepts the same allow action used by REST permissions", async () => {
		const { approvals } = setup();
		const answer = makeWebUIContext(approvals).confirm("title", "message");
		approvals.settle(approvals.pendingList()[0]!.requestId, {
			action: "allow",
			data: { allowed: true },
		});
		expect(await answer).toBe(true);
	});

	test("UI dialogs forward signal and timeout", async () => {
		const { approvals } = setup();
		const ui = makeWebUIContext(approvals);
		const controller = new AbortController();
		const selection = ui.select("choose", ["one"], { signal: controller.signal });
		controller.abort();
		expect(approvals.pendingList()).toEqual([]);
		expect(await selection).toBeUndefined();
		expect(await ui.input("name", "", { timeout: 1 })).toBeUndefined();
		expect(await ui.confirm("ok", "continue", { timeout: 1 })).toBe(false);
	});

	test("ask cancellation is an error result and its signal removes pending cards", async () => {
		const { approvals, tool } = setup();
		const controller = new AbortController();
		const answer = tool.execute(
			"ask",
			{ questions: [{ question: "which?", options: [] }] },
			controller.signal,
			undefined,
			{} as never,
		);
		controller.abort();
		expect(approvals.pendingList()).toEqual([]);
		const result = await answer;
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("用户取消") }]);
	});

	test("empty or duplicate question titles cannot create ambiguous answers", async () => {
		const { approvals, tool } = setup();
		const schema = tool.parameters as unknown as {
			properties: { questions: { minItems?: number } };
		};
		expect(schema.properties.questions.minItems).toBe(1);
		const answer = tool.execute(
			"duplicate",
			{
				questions: [
					{ question: "same", options: [] },
					{ question: "same", options: [] },
				],
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(approvals.pendingList()).toEqual([]);
		expect((await answer).isError).toBe(true);
	});

	test("ask close is reported as cancellation, and valid answers keep question flags", async () => {
		const { approvals, tool } = setup();
		const questions = [
			{ question: "which?", options: [], allowCustom: true, required: false, notes: "hint" },
		];
		const cancelled = tool.execute("closed", { questions }, undefined, undefined, {} as never);
		approvals.rejectAll("close");
		expect((await cancelled).isError).toBe(true);
		const answered = tool.execute("answered", { questions }, undefined, undefined, {} as never);
		expect(approvals.get("answered")?.payload).toEqual({ questions });
		approvals.settle("answered", { action: "answer", data: { answers: { "which?": "custom" } } });
		const result = await answered;
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("custom") }]);
	});

	test("asking users is available in every mode while unknown tools keep their gate", () => {
		for (const mode of ["plan", "safe", "standard", "auto"] as const) {
			expect(judgeToolCall(mode, "ask_user_question", {})).toBe("allow");
		}
		expect(judgeToolCall("plan", "unknown", {})).toBe("block");
		expect(judgeToolCall("safe", "unknown", {})).toBe("confirm");
	});
});
