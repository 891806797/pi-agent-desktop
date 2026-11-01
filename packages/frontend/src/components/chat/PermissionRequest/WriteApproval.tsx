import type { ToolPermissionPayload } from "@pi-agent/common";
import { ApprovalShell, type OnApprove } from "./ApprovalShell";

export function WriteApproval({
	permission,
	onApprove,
}: {
	permission: ToolPermissionPayload;
	onApprove: OnApprove;
}): React.JSX.Element {
	const fp = String(permission.input.path ?? "");
	const content =
		typeof permission.input.content === "string"
			? permission.input.content
			: JSON.stringify(permission.input, null, 2);

	return (
		<ApprovalShell toolName={permission.toolName} onApprove={onApprove}>
			<div className="mb-1.5 font-mono text-[12px] text-[var(--text-muted)]">{fp}</div>
			{typeof content === "string" && (
				<pre className="whitespace-pre-wrap break-words rounded border border-[var(--border-muted)] bg-[var(--bg-layer-02)] p-2 font-mono text-[12px] text-[var(--text-base)]">
					{content}
				</pre>
			)}
		</ApprovalShell>
	);
}
