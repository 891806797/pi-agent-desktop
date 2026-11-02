/**
 * 桌面使用可调侧栏，窄屏通过对话框访问项目和会话，聊天区始终保留完整宽度。
 */

import type { WorkspaceInfo } from "@pi-agent/common";
import { MenuIcon, PanelRightIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { FileTree } from "@/components/chat/FileTree";
import { DirectoryPicker } from "@/components/layout/DirectoryPicker";
import { ProjectRail } from "@/components/layout/ProjectRail";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { SessionMetricsBar } from "@/components/layout/SessionMetricsBar";
import { SidebarPanel, sessionLabel } from "@/components/layout/SidebarPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { resolveProjectChatPath, useChatAgent } from "@/hooks/useChatAgent";
import { useChatAgentApi } from "@/hooks/useChatAgentApi";
import { addWorkspace, deleteSession, listWorkspaces } from "@/lib/api";
import { useChatStore } from "@/stores/chat";
import { needsAttention, useSessionsStore } from "@/stores/sessions";

const FileEditorDialog = lazy(() =>
	import("@/components/chat/FileEditorDialog").then((module) => ({
		default: module.FileEditorDialog,
	})),
);

const DEFAULT_SIDE = 344;
const MIN_SIDE = 280;
const MAX_SIDE = 520;
const sidebarMax = () => Math.max(MIN_SIDE, Math.min(MAX_SIDE, window.innerWidth - 448));

function loadSide(): number {
	const v = Number(localStorage.getItem("pi-agent:sidebar-width"));
	return Number.isFinite(v) && v >= MIN_SIDE ? v : DEFAULT_SIDE;
}

export function ChatPage() {
	useChatAgent();
	const navigate = useNavigate();
	const location = useLocation();
	const status = useChatStore((s) => s.status);
	const metrics = useChatStore((s) => s.metrics);
	const directory = useSessionsStore((state) => state.rows);
	const removed = useSessionsStore((state) => state.removed);
	const [attentionOpen, setAttentionOpen] = useState(false);
	const [retryingDelete, setRetryingDelete] = useState<string | null>(null);
	const attention = Object.values(directory).filter(needsAttention);

	const [projects, setProjects] = useState<WorkspaceInfo[]>([]);
	const activeEncoded = new URLSearchParams(location.search).get("workspace");
	const currentSid = new URLSearchParams(location.search).get("sessionId");
	const projectRequest = useRef(0);
	useEffect(() => {
		if (currentSid && removed[currentSid])
			navigate(`/chat?workspace=${activeEncoded}`, { replace: true });
	}, [currentSid, removed, activeEncoded, navigate]);
	const [editingFile, setEditingFile] = useState<{ projectId: string; path: string } | null>(null);
	const editFile = (path: string) => {
		if (activeEncoded) setEditingFile({ projectId: activeEncoded, path });
	};
	const [filesOpen, setFilesOpen] = useState(
		() => localStorage.getItem("pi-agent:files-open") !== "false",
	);
	const [filesMobileOpen, setFilesMobileOpen] = useState(false);
	const [viewport, setViewport] = useState(window.innerWidth);
	const [fileWidth, setFileWidth] = useState(() => {
		const value = Number(localStorage.getItem("pi-agent:files-width"));
		return Number.isFinite(value) && value >= 240 ? Math.min(value, 520) : 288;
	});
	const showFileSidebar = filesOpen && viewport >= 1100 && !!activeEncoded;
	const maxFileWidth = Math.max(240, Math.min(520, viewport - 448 - MIN_SIDE));
	const effectiveFileWidth = Math.min(fileWidth, maxFileWidth);
	const [side, setSide] = useState(loadSide);
	const [maxSide, setMaxSide] = useState(sidebarMax);
	const sidebarWidth = Math.min(
		side,
		maxSide,
		showFileSidebar ? Math.max(MIN_SIDE, viewport - effectiveFileWidth - 448) : maxSide,
	);
	const [addOpen, setAddOpen] = useState(false);
	const [navigationOpen, setNavigationOpen] = useState(false);

	// 当前项目只由 URL 决定，项目列表请求不能改变会话坐标。
	useEffect(() => {
		let cancelled = false;
		void listWorkspaces()
			.then((r) => {
				if (cancelled) return;
				setProjects(r.workspaces);
			})
			.catch((err) => {
				if (!cancelled) useChatStore.setState({ lastError: String(err) });
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// 窗口尺寸变化 → 拖宽上限更新
	useEffect(() => {
		const onResize = () => {
			setMaxSide(sidebarMax());
			setViewport(window.innerWidth);
			if (window.innerWidth >= 1100) setFilesMobileOpen(false);
			if (window.innerWidth >= 768) setNavigationOpen(false);
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const persistSide = useCallback((w: number) => {
		setSide(w);
	}, []);
	const onResizeEnd = useCallback((width: number) => {
		localStorage.setItem("pi-agent:sidebar-width", String(width));
	}, []);

	useEffect(() => {
		const close = () => setFilesMobileOpen(false);
		window.addEventListener("composer:insert", close);
		return () => window.removeEventListener("composer:insert", close);
	}, []);
	const activeProject = projects.find((p) => p.encoded === activeEncoded) ?? null;
	const agent = useChatAgentApi({ projectId: activeEncoded });

	const openSession = useCallback(
		(sid: string) => {
			projectRequest.current++;
			setNavigationOpen(false);
			navigate(`/chat?workspace=${activeEncoded}&sessionId=${sid}`, { replace: true });
		},
		[navigate, activeEncoded],
	);
	const newSession = useCallback(() => {
		projectRequest.current++;
		setNavigationOpen(false);
		navigate(`/chat?workspace=${activeEncoded}`, { replace: true });
	}, [navigate, activeEncoded]);
	const selectProject = useCallback(
		async (encoded: string) => {
			const request = ++projectRequest.current;
			if (encoded === activeEncoded) return;
			const search = window.location.search;
			try {
				const target = await resolveProjectChatPath(encoded);
				if (request === projectRequest.current && window.location.search === search) {
					setNavigationOpen(false);
					navigate(target, { replace: true });
				}
			} catch (error) {
				if (request === projectRequest.current && window.location.search === search)
					toast.error(error instanceof Error ? error.message : String(error));
			}
		},
		[navigate, activeEncoded],
	);

	const onPickDirectory = useCallback(
		async (path: string) => {
			try {
				const r = await addWorkspace(path);
				setProjects((prev) =>
					prev.some((p) => p.encoded === r.workspace.encoded) ? prev : [...prev, r.workspace],
				);
				selectProject(r.workspace.encoded);
			} catch (err) {
				console.error("[addProject]", err);
			}
			setAddOpen(false);
		},
		[selectProject],
	);

	const navigation = (
		<>
			<ProjectRail
				projects={projects}
				activeEncoded={activeEncoded}
				onSelect={selectProject}
				onAddProject={() => {
					setNavigationOpen(false);
					setAddOpen(true);
				}}
			/>
			{activeProject ? (
				<SidebarPanel
					project={activeProject}
					onOpenSession={openSession}
					onNewSession={newSession}
				/>
			) : (
				<div className="flex flex-1 items-center justify-center rounded-tl-[12px] border-l border-t border-[var(--border-muted)] bg-[var(--bg-base)] text-xs text-[var(--text-muted)]">
					点击 + 添加项目文件夹
				</div>
			)}
		</>
	);
	return (
		<div className="flex h-dvh select-none flex-col bg-[var(--bg-deep)] [&_input]:select-text [&_textarea]:select-text">
			{/* Titlebar（对齐 opencode：h-10 顶栏） */}
			<header className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--bg-deep)] px-3 py-1 sm:h-10 sm:flex-nowrap sm:py-0">
				<Dialog open={navigationOpen} onOpenChange={setNavigationOpen}>
					<DialogTrigger
						aria-label="打开项目与会话"
						className="flex size-8 shrink-0 items-center justify-center rounded md:hidden hover:bg-[var(--bg-layer-01)] focus-visible:outline-2"
					>
						<MenuIcon className="size-4" />
					</DialogTrigger>
					<DialogContent className="md:hidden sm:max-w-sm" aria-describedby={undefined}>
						<DialogTitle>项目与会话</DialogTitle>
						<nav aria-label="项目与会话" className="flex h-[65dvh] min-h-0 overflow-hidden">
							{navigation}
						</nav>
					</DialogContent>
				</Dialog>
				<span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-[var(--text-base)]">
					pi-agent
				</span>
				{activeProject && (
					<span
						className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]"
						title={activeProject.path}
					>
						{activeProject.path}
					</span>
				)}
				<SessionMetricsBar metrics={metrics} />
				<Button
					size="sm"
					variant="ghost"
					aria-label="文件面板"
					aria-expanded={viewport >= 1100 ? filesOpen : filesMobileOpen}
					disabled={!activeEncoded}
					onClick={() => {
						if (viewport < 1100) setFilesMobileOpen(true);
						else {
							setFilesOpen(!filesOpen);
							localStorage.setItem("pi-agent:files-open", String(!filesOpen));
						}
					}}
				>
					<PanelRightIcon className="size-4" />
					<span className="hidden sm:inline">文件</span>
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={() => setAttentionOpen(true)}>
					待处理 {attention.length || ""}
				</Button>
				<span className="shrink-0 text-xs text-[var(--text-muted)]">{status}</span>
			</header>

			<div className="flex min-h-0 flex-1">
				{/* 左侧：项目 rail + 会话面板 */}
				<nav
					aria-label="项目与会话"
					className="hidden h-full shrink-0 overflow-hidden md:flex"
					style={{ width: sidebarWidth }}
				>
					{navigation}
				</nav>

				{/* 分割线：会话面板 ↔ 聊天 */}
				<ResizeHandle
					size={sidebarWidth}
					min={MIN_SIDE}
					max={maxSide}
					onResize={persistSide}
					onEnd={onResizeEnd}
				/>

				{/* 聊天区包含消息流、审批与输入框。 */}
				<main className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-t border-[var(--border-muted)] bg-[var(--bg-base)]">
					{activeEncoded ? (
						<ChatMessageList agent={agent} />
					) : (
						<div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
							<h1 className="text-lg font-medium text-[var(--text-base)]">选择项目，开始聊天</h1>
							<p className="max-w-sm text-sm text-[var(--text-muted)]">
								选择一个项目文件夹，智能体将在此处理文件与任务。
							</p>
							<Button onClick={() => setAddOpen(true)}>选择项目文件夹</Button>
						</div>
					)}
				</main>
				{showFileSidebar && (
					<>
						<ResizeHandle
							size={effectiveFileWidth}
							min={240}
							max={maxFileWidth}
							defaultSize={288}
							side="right"
							label="调整文件面板宽度"
							onResize={setFileWidth}
							onEnd={(width) => localStorage.setItem("pi-agent:files-width", String(width))}
						/>
						<aside
							aria-label="项目文件"
							className="h-full shrink-0 overflow-hidden border-l border-t border-[var(--border-muted)] bg-[var(--bg-layer-01)]"
							style={{ width: effectiveFileWidth }}
						>
							<FileTree key={activeEncoded} projectId={activeEncoded} onEdit={editFile} />
						</aside>
					</>
				)}
				<Dialog open={filesMobileOpen} onOpenChange={setFilesMobileOpen}>
					<DialogContent
						className="flex h-[85dvh] flex-col sm:max-w-md"
						aria-describedby={undefined}
					>
						<DialogTitle>项目文件</DialogTitle>
						<div className="min-h-0 flex-1">
							<FileTree key={activeEncoded} projectId={activeEncoded} onEdit={editFile} />
						</div>
					</DialogContent>
				</Dialog>
			</div>
			{editingFile && (
				<Suspense fallback={<p role="status">加载编辑器…</p>}>
					<FileEditorDialog
						open
						projectId={editingFile.projectId}
						path={editingFile.path}
						onOpenChange={(open) => {
							if (!open) setEditingFile(null);
						}}
					/>
				</Suspense>
			)}
			<DirectoryPicker
				open={addOpen}
				onClose={() => setAddOpen(false)}
				onConfirm={(p) => void onPickDirectory(p)}
			/>
			<Dialog open={attentionOpen} onOpenChange={setAttentionOpen}>
				<DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
					<DialogTitle>待处理与未读</DialogTitle>
					{!attention.length && (
						<p className="text-sm text-[var(--text-muted)]">暂时没有需要处理的会话。</p>
					)}
					{attention.map((row) => {
						const project = projects.find((project) => project.path === row.workspace);
						return (
							<button
								key={row.sessionId}
								type="button"
								disabled={!!retryingDelete || (!project && row.lifecycle !== "deleting")}
								className="rounded-md border p-3 text-left hover:bg-[var(--overlay-hover)]"
								onClick={() => {
									if (row.lifecycle === "deleting") {
										setRetryingDelete(row.sessionId);
										void deleteSession(row.sessionId, row.revision, true)
											.catch((error) =>
												toast.error(error instanceof Error ? error.message : String(error)),
											)
											.finally(() => setRetryingDelete(null));
										return;
									}
									if (project) {
										navigate(`/chat?workspace=${project.encoded}&sessionId=${row.sessionId}`, {
											replace: true,
										});
										setAttentionOpen(false);
									}
								}}
							>
								<span className="block truncate text-sm">
									{row.name || row.firstMessage || "新会话"}
								</span>
								<span className="text-xs text-[var(--text-muted)]">
									{project?.name || row.workspace} ·{" "}
									{row.lifecycle === "deleting" ? "重试删除" : sessionLabel(row) || "未读"}
								</span>
								{row.managementError && (
									<span className="block whitespace-pre-wrap break-words text-xs text-destructive">
										{row.managementError}
									</span>
								)}
							</button>
						);
					})}
				</DialogContent>
			</Dialog>
		</div>
	);
}
