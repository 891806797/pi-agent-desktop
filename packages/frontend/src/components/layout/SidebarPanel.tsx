/**
 * SidebarPanel —— 会话面板（复刻 opencode SidebarPanel）。
 * 头部：项目名 + 路径；New session 全宽按钮；会话列表（状态点 + 标题）；底部用户名。
 */

import type { SessionSummary, WorkspaceInfo } from "@pi-agent/common";
import { Loader2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { listSessions } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";

export function SidebarPanel({
	project,
	onOpenSession,
	onNewSession,
}: {
	project: WorkspaceInfo;
	onOpenSession: (sid: string) => void;
	onNewSession: () => void;
}) {
	const username = useAuthStore((s) => s.username);
	const currentSid = useChatStore((s) => s.sessionId);
	const status = useChatStore((s) => s.status);
	const [result, setResult] = useState<{ workspace: string; sessions: SessionSummary[] } | null>(
		null,
	);
	const sessions = result?.workspace === project.encoded ? result.sessions : [];

	// biome-ignore lint/correctness/useExhaustiveDependencies: 新建或切换会话后刷新列表。
	useEffect(() => {
		let cancelled = false;
		void listSessions(project.encoded)
			.then((r) => {
				if (!cancelled) setResult({ workspace: project.encoded, sessions: r.sessions });
			})
			.catch(() => {
				if (!cancelled) setResult({ workspace: project.encoded, sessions: [] });
			});
		return () => {
			cancelled = true;
		};
	}, [project.encoded, currentSid]);

	return (
		<div className="flex h-full w-full min-w-0 flex-1 flex-col rounded-tl-[12px] border-l border-t border-[var(--border-muted)] bg-[var(--bg-base)] px-3">
			{/* New session 全宽按钮 */}
			<div className="shrink-0 py-3">
				<Button size="lg" className="w-full gap-1.5 text-[13px]" onClick={onNewSession}>
					<Plus className="size-4" /> 新建会话
				</Button>
			</div>

			{/* 会话列表 */}
			<div className="flex size-full min-h-0 flex-col gap-1 overflow-y-auto pb-2">
				{sessions.length === 0 && (
					<div className="px-2 py-2 text-[12px] text-[var(--text-faint)]">暂无会话</div>
				)}
				{sessions.map((s) => {
					const active = s.sessionId === currentSid;
					const working = active && status !== "idle";
					return (
						<div
							key={s.sessionId}
							className={`group/session relative w-full min-w-0 cursor-default rounded-md pr-2 transition-colors hover:bg-[var(--overlay-hover)] ${
								active ? "bg-[var(--bg-layer-01)]" : ""
							}`}
							style={{ paddingLeft: 8 }}
						>
							{/* 选中态左侧指示条 */}
							{active && (
								<span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-primary" />
							)}
							<button
								type="button"
								onClick={() => onOpenSession(s.sessionId)}
								className="flex w-full min-w-0 items-center gap-2 py-1 text-left"
							>
								<span className="flex size-6 shrink-0 items-center justify-center">
									{working ? (
										<Loader2 className="size-[15px] animate-spin text-[var(--text-muted)]" />
									) : (
										s.live && <span className="size-1.5 rounded-full bg-green-500" />
									)}
								</span>
								<span className="min-w-0 flex-1 truncate text-[14px] text-[var(--text-base)]">
									{s.firstMessage || "新会话"}
								</span>
							</button>
						</div>
					);
				})}
			</div>

			{/* 底部用户 */}
			<div className="shrink-0 px-2 py-2 text-[12px] text-[var(--text-faint)]">
				{username ?? ""}
			</div>
		</div>
	);
}
