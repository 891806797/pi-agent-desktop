import type { ToolPermissionPayload } from "@pi-agent/common";
import { ApprovalShell, type OnApprove } from "./ApprovalShell";

export function BashApproval({
	permission,
	onApprove,
}: {
	permission: ToolPermissionPayload;
	onApprove: OnApprove;
}): React.JSX.Element {
	const cmd =
		(permission.input as { command?: string }).command ?? JSON.stringify(permission.input, null, 2);
	return (
		<ApprovalShell toolName={permission.toolName} onApprove={onApprove}>
			<pre className="whitespace-pre-wrap break-words rounded border border-[var(--border-muted)] bg-[var(--bg-layer-02)] p-2 font-mono text-[12px] text-[var(--text-base)]">
				{cmd}
			</pre>
		</ApprovalShell>
	);
}
