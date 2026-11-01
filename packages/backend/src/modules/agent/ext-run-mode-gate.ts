/**
 * run mode 权限门 —— 内联扩展工厂（tool_call 事件异步拦截）。
 *
 * pi 无内置 run mode：本扩展按 RunModeHolder 当前值分档（§5.4），
 * confirm 档经 ApprovalManager 挂起等待任一 tab 的用户决定；
 * holder 为引用类型，REST 切换 run mode 即时生效（闭包实时读）。
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { RunMode } from "@pi-agent/common";
import { type ApprovalManager, requestToolPermission } from "./approval-manager";
import { BLOCK_REASON_PLAN, judgeToolCall } from "./dangerous-commands";

/** 闭包共享的可变 run mode（REST 切换即改此值） */
export class RunModeHolder {
	constructor(
		public mode: RunMode,
		private readonly onChange?: (mode: RunMode) => void,
	) {}

	set(mode: RunMode): void {
		this.mode = mode;
		this.onChange?.(mode);
	}
}

export function makeRunModeGateExt(
	runMode: RunModeHolder,
	approvals: ApprovalManager,
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
			const input = (event.input ?? {}) as Record<string, unknown>;
			const judgment = judgeToolCall(runMode.mode, event.toolName, input);
			if (judgment === "allow" && !approvals.hasRestoredPending(event.toolCallId)) return undefined;
			if (judgment === "block") return { block: true, reason: BLOCK_REASON_PLAN };

			const result = await requestToolPermission(
				approvals,
				event.toolCallId,
				event.toolName,
				input,
				() => runMode.mode,
			);
			if (result.allowed) {
				// 审批等待期间模式可能已改变，按执行时的约束再校验一次。
				if (judgeToolCall(runMode.mode, event.toolName, input) === "block")
					return { block: true, reason: BLOCK_REASON_PLAN };
				return undefined;
			}
			return { block: true, reason: result.reason ?? "用户拒绝了本次工具调用" };
		});
	};
}
