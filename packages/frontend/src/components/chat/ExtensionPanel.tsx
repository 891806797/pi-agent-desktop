import type { ExtensionUISnapshot } from "@pi-agent/common";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useChatStore } from "@/stores/chat";

export function ExtensionPanel({
	ui,
	placement,
}: {
	ui: ExtensionUISnapshot;
	placement: "aboveEditor" | "belowEditor";
}) {
	const notifications = useChatStore((state) => state.notifications);
	const seen = useRef(new Set<string>());
	useEffect(() => {
		if (placement !== "aboveEditor") return;
		for (const item of notifications) {
			if (seen.current.has(item.id)) continue;
			seen.current.add(item.id);
			if (document.visibilityState === "visible") toast(item.message, { id: item.id });
		}
		if (seen.current.size > 128) seen.current = new Set(notifications.map((item) => item.id));
	}, [notifications, placement]);
	const statuses = placement === "aboveEditor" ? Object.entries(ui.statuses) : [];
	const widgets = Object.entries(ui.widgets).filter(([, widget]) => widget.placement === placement);
	if (!statuses.length && !widgets.length) return null;
	return (
		<aside
			aria-label="扩展信息"
			className="shrink-0 max-h-48 overflow-auto border-t px-4 py-2 text-xs text-[var(--text-muted)]"
		>
			{statuses.length > 0 && (
				<div role="status" className="flex flex-wrap gap-x-4 gap-y-1">
					{statuses.map(([key, text]) => (
						<span key={key} className="whitespace-pre-wrap break-words">
							{text}
						</span>
					))}
				</div>
			)}
			{widgets.map(([key, widget]) => (
				<details key={key} className="mt-1 rounded border border-[var(--border-muted)] px-2 py-1">
					<summary className="cursor-pointer select-none">{key}</summary>
					<pre className="max-h-32 select-text overflow-auto whitespace-pre-wrap break-words py-2 font-mono text-xs">
						{widget.lines.join("\n")}
					</pre>
				</details>
			))}
		</aside>
	);
}
