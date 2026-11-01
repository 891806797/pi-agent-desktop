import type { ApprovalActionInput } from "@pi-agent/common/dto/requests";
import type React from "react";
import { Button } from "@/components/ui/button";

export type OnApprove = (
	action: ApprovalActionInput["action"],
	data?: unknown,
) => void | Promise<void>;

/**
 * 公共审批外壳（dock 风格）：header（工具名）+ content（自定义）+ footer（拒绝/允许）。
 * header/footer 固定，content 区独立滚动。
 */
export function ApprovalShell({
	toolName,
	children,
	onApprove,
}: {
	toolName: string;
	children?: React.ReactNode;
	onApprove: OnApprove;
}): React.JSX.Element {
	return (
		<div className="mx-4 my-2 rounded-lg border border-[var(--border-base)] bg-[var(--bg-layer-01)] shadow-[var(--elevation-raised)] overflow-hidden flex flex-col max-h-[55vh]">
			<div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border-muted)] shrink-0">
				<span className="size-2 rounded-full bg-[var(--grey-500)] animate-pulse" />
				<span className="text-[13px] font-medium text-[var(--text-base)]">工具调用审批</span>
				<span className="rounded border border-[var(--border-base)] bg-[var(--bg-layer-02)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-base)]">
					{toolName}
				</span>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">{children}</div>

			<div className="flex items-center gap-2 px-4 py-2.5 border-t border-[var(--border-muted)] shrink-0">
				<Button
					variant="outline"
					size="sm"
					className="border-[var(--border-base)] bg-[var(--bg-layer-02)] text-[var(--text-base)] hover:bg-[var(--overlay-hover)]"
					onClick={() => onApprove("deny")}
				>
					拒绝
				</Button>
				<div className="flex-1" />
				<Button variant="secondary" size="sm" onClick={() => onApprove("allow")}>
					允许
				</Button>
			</div>
		</div>
	);
}
