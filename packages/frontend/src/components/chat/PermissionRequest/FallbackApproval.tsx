import type { ToolPermissionPayload } from "@pi-agent/common";
import { ApprovalShell, type OnApprove } from "./ApprovalShell";

export function FallbackApproval({
	permission,
	onApprove,
}: {
	permission: ToolPermissionPayload;
	onApprove: OnApprove;
}): React.JSX.Element {
	return (
		<ApprovalShell toolName={permission.toolName} onApprove={onApprove}>
			<details className="text-xs">
				<summary className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-base)]">
					展开参数
				</summary>
				<pre className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap rounded border border-[var(--border-muted)] bg-[var(--bg-layer-01)] p-2 font-mono text-[12px] text-[var(--text-faint)]">
					{JSON.stringify(permission.input, null, 2)}
				</pre>
			</details>
		</ApprovalShell>
	);
}
