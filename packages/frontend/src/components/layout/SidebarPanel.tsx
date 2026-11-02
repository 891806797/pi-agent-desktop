/**
 * SidebarPanel —— 会话面板（复刻 opencode SidebarPanel）。
 * 头部：项目名 + 路径；New session 全宽按钮；会话列表（状态点 + 标题）；底部用户名。
 */

import type { CatalogSession, WorkspaceInfo } from "@pi-agent/common";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ApiError, deleteSession, listCatalog, updateSession } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { useSessionsStore } from "@/stores/sessions";

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
	const changes = useSessionsStore((state) => state.changes);
	const projected = useSessionsStore((state) => state.rows);
	const removed = useSessionsStore((state) => state.removed);
	const [q, setQ] = useState("");
	const [archived, setArchived] = useState(false);
	const [cursor, setCursor] = useState<string | null>(null);
	const [refresh, setRefresh] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState<{ kind: "rename" | "delete"; row: CatalogSession } | null>(
		null,
	);
	const [name, setName] = useState("");
	const viewKey = JSON.stringify([project.encoded, q, archived]);
	const scope = JSON.stringify([viewKey, changes, currentSid, refresh]);
	const activeScope = useRef(scope);
	activeScope.current = scope;
	const activeView = useRef(viewKey);
	activeView.current = viewKey;
	const [result, setResult] = useState<{ viewKey: string; sessions: CatalogSession[] } | null>(
		null,
	);
	const sessions =
		result?.viewKey === viewKey
			? result.sessions
					.filter((row) => !removed[row.sessionId])
					.map((row) => projected[row.sessionId] ?? row)
					.filter(
						(row) =>
							!!row.archivedAt === archived &&
							(!q ||
								`${row.name ?? ""}\n${row.firstMessage}`
									.toLocaleLowerCase()
									.includes(q.toLocaleLowerCase())),
					)
			: [];

	// biome-ignore lint/correctness/useExhaustiveDependencies: 新建或切换会话后刷新列表。
	useEffect(() => {
		let cancelled = false;
		setCursor(null);
		const timer = setTimeout(() => {
			void listCatalog({ workspace: project.encoded, q, archived })
				.then((r) => {
					if (!cancelled) {
						setResult({ viewKey, sessions: r.sessions });
						setCursor(r.nextCursor);
						setError(null);
					}
				})
				.catch((error) => {
					if (!cancelled) setError(String(error));
				});
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [project.encoded, currentSid, q, archived, changes, refresh]);

	async function act(action: () => Promise<unknown>, reload = true) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await action();
			if (activeView.current !== viewKey) return;
			setDialog(null);
			if (reload) setRefresh((value) => value + 1);
		} catch (error) {
			if (activeView.current === viewKey)
				setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	async function more() {
		if (!cursor) return;
		await act(async () => {
			try {
				const next = await listCatalog({ workspace: project.encoded, q, archived, cursor });
				if (activeScope.current !== scope) return;
				setResult((old) => ({
					viewKey,
					sessions: [
						...new Map(
							[...(old?.sessions ?? []), ...next.sessions].map((row) => [row.sessionId, row]),
						).values(),
					],
				}));
				setCursor(next.nextCursor);
			} catch (error) {
				if (activeScope.current !== scope) return;
				if (error instanceof ApiError && error.code === "CURSOR_EXPIRED")
					setRefresh((value) => value + 1);
				else throw error;
			}
		}, false);
	}

	return (
		<div className="flex h-full w-full min-w-0 flex-1 flex-col rounded-tl-[12px] border-l border-t border-[var(--border-muted)] bg-[var(--bg-base)] px-3">
			{/* New session 全宽按钮 */}
			<div className="shrink-0 py-3">
				<Button size="lg" className="w-full gap-1.5 text-[13px]" onClick={onNewSession}>
					<Plus className="size-4" /> 新建会话
				</Button>
			</div>
			<div className="mb-2 flex items-center gap-1">
				<Input
					aria-label="搜索会话"
					placeholder="搜索会话"
					value={q}
					onChange={(event) => setQ(event.target.value)}
					className="h-8 min-w-0 text-xs"
				/>
				<Button
					size="sm"
					variant={archived ? "secondary" : "ghost"}
					aria-pressed={archived}
					onClick={() => setArchived(!archived)}
				>
					归档
				</Button>
			</div>
			{error && (
				<p role="alert" className="mb-2 whitespace-pre-wrap break-words text-xs text-destructive">
					{error}
				</p>
			)}

			{/* 会话列表 */}
			<div className="flex size-full min-h-0 flex-col gap-1 overflow-y-auto pb-2">
				{sessions.length === 0 && (
					<div className="px-2 py-2 text-[12px] text-[var(--text-faint)]">暂无会话</div>
				)}
				{sessions.map((s) => {
					const active = s.sessionId === currentSid;
					const label = sessionLabel(s);
					const working = ["运行中", "恢复中"].includes(label);
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
								disabled={s.lifecycle === "deleting"}
								aria-label={s.name || s.firstMessage || "新会话"}
								aria-description={label || undefined}
								onClick={() => onOpenSession(s.sessionId)}
								className="flex min-h-11 w-full min-w-0 items-center gap-2 py-1 pr-7 text-left"
							>
								<span className="flex size-6 shrink-0 items-center justify-center">
									{working ? (
										<Loader2 className="size-[15px] animate-spin text-[var(--text-muted)]" />
									) : (
										s.live && <span className="size-1.5 rounded-full bg-green-500" />
									)}
								</span>
								<span className="min-w-0 flex-1 text-[13px] text-[var(--text-base)]">
									<span className="block truncate">{s.name || s.firstMessage || "新会话"}</span>
									{label && (
										<span className="block text-[11px] text-[var(--text-muted)]">
											{label}
											{s.noticeVersion > s.readVersion ? " · 未读" : ""}
										</span>
									)}
								</span>
							</button>
							<DropdownMenu>
								<DropdownMenuTrigger
									aria-label={`管理会话 ${s.name || s.firstMessage || "新会话"}`}
									className="absolute right-0 top-2 flex size-8 items-center justify-center rounded hover:bg-[var(--overlay-hover)]"
								>
									<MoreHorizontal className="size-4" />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										disabled={s.lifecycle === "deleting"}
										onClick={() => {
											setName(s.name || s.firstMessage);
											setDialog({ kind: "rename", row: s });
										}}
									>
										重命名
									</DropdownMenuItem>
									<DropdownMenuItem
										disabled={busy || s.lifecycle === "deleting"}
										onClick={() =>
											void act(() =>
												updateSession(s.sessionId, s.revision, { archived: !s.archivedAt }),
											)
										}
									>
										{s.archivedAt ? "取消归档" : "归档会话"}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => setDialog({ kind: "delete", row: s })}
										className="text-destructive"
									>
										{s.lifecycle === "deleting" ? "重试删除" : "删除会话"}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					);
				})}
				{cursor && (
					<Button variant="ghost" disabled={busy} onClick={() => void more()}>
						加载更多
					</Button>
				)}
			</div>
			<Dialog
				open={!!dialog}
				onOpenChange={(open) => {
					if (!open && !busy) setDialog(null);
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogTitle>{dialog?.kind === "rename" ? "重命名会话" : "删除会话"}</DialogTitle>
					<DialogDescription>
						{dialog?.kind === "rename"
							? "修改名称不会影响正在运行的任务。"
							: "将删除聊天历史并停止本会话的任务。项目中的文件会保留。"}
					</DialogDescription>
					{dialog?.row.managementError && (
						<p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">
							上次删除未完成：{dialog.row.managementError}。修复原因后可以重试。
						</p>
					)}
					{dialog?.kind === "rename" && (
						<Input
							aria-label="会话名称"
							maxLength={100}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					)}
					{error && (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					)}
					<Button
						disabled={busy || (dialog?.kind === "rename" && !name.trim())}
						onClick={() => {
							if (!dialog) return;
							const selected = dialog;
							void act(async () => {
								if (selected.kind === "rename")
									await updateSession(selected.row.sessionId, selected.row.revision, {
										name: name.trim(),
									});
								else {
									await deleteSession(selected.row.sessionId, selected.row.revision, true);
									if (selected.row.sessionId === currentSid) onNewSession();
								}
							});
						}}
					>
						{busy ? "处理中…" : dialog?.kind === "rename" ? "保存名称" : "停止并删除会话"}
					</Button>
				</DialogContent>
			</Dialog>

			{/* 底部用户 */}
			<div className="shrink-0 px-2 py-2 text-[12px] text-[var(--text-faint)]">
				{username ?? ""}
			</div>
		</div>
	);
}

export function sessionLabel(row: CatalogSession) {
	if (row.lifecycle === "deleting") return row.managementError ? "删除未完成，可重试" : "删除中";
	if (row.needsReview) return "需核对";
	if (row.pendingPermissions) return `待审批 ${row.pendingPermissions}`;
	if (row.pendingQuestions) return `待回答 ${row.pendingQuestions}`;
	if (row.recovering) return "恢复中";
	if (row.status === "error") return "失败";
	if (row.live && row.status !== "idle") return "运行中";
	if (row.noticeKind === "notification" && row.noticeVersion > row.readVersion) return "有通知";
	return row.noticeKind === "completed" && row.noticeVersion > row.readVersion ? "已完成" : "";
}
