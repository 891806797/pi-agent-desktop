/**
 * 桌面使用可调侧栏，窄屏通过对话框访问项目和会话，聊天区始终保留完整宽度。
 */

import type { WorkspaceInfo } from "@pi-agent/common";
import { MenuIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChatMessageList } from "@/components/chat/ChatMessageList";
import { DirectoryPicker } from "@/components/layout/DirectoryPicker";
import { ProjectRail } from "@/components/layout/ProjectRail";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { SessionMetricsBar } from "@/components/layout/SessionMetricsBar";
import { SidebarPanel } from "@/components/layout/SidebarPanel";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useChatAgent } from "@/hooks/useChatAgent";
import { useChatAgentApi } from "@/hooks/useChatAgentApi";
import { addWorkspace, listWorkspaces } from "@/lib/api";
import { useChatStore } from "@/stores/chat";

const DEFAULT_SIDE = 344;
const MIN_SIDE = 244;

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

	const [projects, setProjects] = useState<WorkspaceInfo[]>([]);
	const activeEncoded = new URLSearchParams(location.search).get("workspace");
	const [side, setSide] = useState(loadSide);
	const [maxSide, setMaxSide] = useState(() => window.innerWidth * 0.3 + 64);
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
			setMaxSide(window.innerWidth * 0.3 + 64);
			if (window.innerWidth >= 768) setNavigationOpen(false);
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const persistSide = useCallback((w: number) => {
		setSide(w);
	}, []);
	const onResizeEnd = useCallback(() => {
		localStorage.setItem("pi-agent:sidebar-width", String(side));
	}, [side]);

	const activeProject = projects.find((p) => p.encoded === activeEncoded) ?? null;
	const agent = useChatAgentApi({ projectId: activeEncoded });

	const openSession = useCallback(
		(sid: string) => {
			setNavigationOpen(false);
			navigate(`/chat?workspace=${activeEncoded}&sessionId=${sid}`, { replace: true });
		},
		[navigate, activeEncoded],
	);
	const newSession = useCallback(() => {
		setNavigationOpen(false);
		navigate(`/chat?workspace=${activeEncoded}`, { replace: true });
	}, [navigate, activeEncoded]);
	const selectProject = useCallback(
		(encoded: string) => {
			if (encoded === activeEncoded) return;
			navigate(`/chat?workspace=${encoded}`, { replace: true });
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
					未配置项目（WORKSPACE_ROOTS）
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
				<span className="shrink-0 text-xs text-[var(--text-muted)]">{status}</span>
			</header>

			<div className="flex min-h-0 flex-1">
				{/* 左侧：项目 rail + 会话面板 */}
				<nav
					aria-label="项目与会话"
					className="hidden h-full shrink-0 overflow-hidden md:flex"
					style={{ width: Math.min(side, Math.max(MIN_SIDE, maxSide)) }}
				>
					{navigation}
				</nav>

				{/* 分割线：会话面板 ↔ 聊天 */}
				<div className="hidden md:block">
					<ResizeHandle
						size={side}
						min={MIN_SIDE}
						max={maxSide}
						onResize={persistSide}
						onEnd={onResizeEnd}
					/>
				</div>

				{/* 聊天 main：rounded-tl 卡片（消息流、审批与输入框） */}
				<main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[12px] border-l border-t border-[var(--border-muted)] bg-[var(--bg-base)]">
					<ChatMessageList agent={agent} />
				</main>
			</div>
			<DirectoryPicker
				open={addOpen}
				onClose={() => setAddOpen(false)}
				onConfirm={(p) => void onPickDirectory(p)}
			/>
		</div>
	);
}
