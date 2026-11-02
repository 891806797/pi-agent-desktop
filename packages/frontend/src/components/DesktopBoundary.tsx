import type {
	DesktopHostStatus,
	DesktopNavigation,
	DesktopNotificationWarning,
} from "@pi-agent/common";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { listWorkspaces } from "@/lib/api";
import { isDesktop, setDesktopNavigationPending, setDesktopVisibility } from "@/lib/desktop";
import { useChatStore } from "@/stores/chat";

export function DesktopBoundary({ children }: { children: React.ReactNode }) {
	const [status, setStatus] = useState<DesktopHostStatus>({ status: "starting" });
	const [started, setStarted] = useState(false);
	const statusRevision = useRef(0);
	const visibilityRevision = useRef(0);
	useEffect(() => {
		if (!isDesktop()) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		let unlistenVisibility: (() => void) | undefined;
		const apply = (next: DesktopHostStatus) => {
			if (disposed) return;
			setStatus(next);
			if (next.status === "ready") {
				setStarted(true);
				const visibility = visibilityRevision.current;
				const generation = statusRevision.current;
				void invoke<boolean>("backend_visibility")
					.then((visible) => {
						if (
							!disposed &&
							visibility === visibilityRevision.current &&
							generation === statusRevision.current
						)
							setDesktopVisibility(visible);
					})
					.catch(() => setDesktopVisibility(false));
			} else setDesktopVisibility(false);
		};
		void (async () => {
			try {
				unlisten = await listen<DesktopHostStatus>("desktop:status", ({ payload }) => {
					statusRevision.current++;
					apply(payload);
				});
				if (disposed) {
					unlisten();
					return;
				}
				unlistenVisibility = await listen<boolean>("desktop:visibility", ({ payload }) => {
					visibilityRevision.current++;
					if (!disposed) setDesktopVisibility(payload);
				});
				if (disposed) {
					unlistenVisibility();
					return;
				}
				const current = statusRevision.current;
				const snapshot = await invoke<DesktopHostStatus>("backend_status");
				if (current === statusRevision.current) apply(snapshot);
			} catch (error) {
				apply({ status: "failed", error: String(error) });
			}
		})();
		return () => {
			disposed = true;
			unlisten?.();
			unlistenVisibility?.();
			setDesktopVisibility(false);
		};
	}, []);
	if (!isDesktop()) return children;
	const retry = async () => {
		setStatus({ status: "starting" });
		setDesktopVisibility(false);
		try {
			await invoke("backend_restart");
			const current = statusRevision.current;
			const snapshot = await invoke<DesktopHostStatus>("backend_status");
			if (current === statusRevision.current) {
				setStatus(snapshot);
				if (snapshot.status === "ready") {
					setStarted(true);
					const visibility = visibilityRevision.current;
					const visible = await invoke<boolean>("backend_visibility");
					if (current === statusRevision.current && visibility === visibilityRevision.current)
						setDesktopVisibility(visible);
				}
			}
		} catch (error) {
			setStatus({ status: "failed", error: String(error) });
		}
	};
	const failed = status.status === "failed";
	return (
		<>
			{/* 故障期间保留已挂载页面和草稿，恢复后由既有连接逻辑重新对账。 */}
			{started && <div hidden={status.status !== "ready"}>{children}</div>}
			{status.status !== "ready" && (
				<main className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6">
					<section
						className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-card p-7 shadow-sm"
						aria-label="桌面服务状态"
					>
						<div className="flex size-11 items-center justify-center rounded-xl bg-secondary text-primary">
							{failed ? (
								<AlertCircle aria-hidden="true" />
							) : (
								<LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
							)}
						</div>
						<div className="space-y-2" role={failed ? "alert" : "status"}>
							<h1 className="text-lg font-semibold">
								{failed
									? "本地服务暂时不可用"
									: status.status === "stopping"
										? "正在保存并退出"
										: "正在启动 Pi Agent"}
							</h1>
							<p className="text-sm leading-6 text-muted-foreground">
								{failed
									? "你的历史和配置仍保存在本机。可以重试启动服务。"
									: status.status === "stopping"
										? "正在保存会话并回收工具进程，请稍候。"
										: "正在准备本地服务与会话数据，请稍候。"}
							</p>
							{failed && status.error && (
								<p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs leading-5">
									{status.error}
								</p>
							)}
						</div>
						{failed && (
							<Button type="button" size="lg" onClick={() => void retry()} className="w-full">
								<RefreshCw aria-hidden="true" />
								重新启动
							</Button>
						)}
					</section>
				</main>
			)}
		</>
	);
}

/** 使用服务端项目编码定位，沿用现有路由和项目访问校验。 */
export function DesktopEventListener() {
	const navigate = useNavigate();
	const route = useLocation();
	const pending = useRef<{ sessionId: string; workspace?: string } | null>(null);
	useEffect(() => {
		if (
			pending.current &&
			new URLSearchParams(route.search).get("sessionId") !== pending.current.sessionId
		) {
			pending.current = null;
			setDesktopNavigationPending(false);
		}
	}, [route.search]);
	useEffect(() => {
		if (!isDesktop()) return;
		let closed = false;
		let unlisten: (() => void) | undefined;
		let unlistenWarning: (() => void) | undefined;
		const finishNavigation = () => {
			const target = pending.current;
			const chat = useChatStore.getState();
			const url = new URLSearchParams(location.search);
			if (
				target?.workspace &&
				!chat.isSwitchingSession &&
				chat.sessionId === target.sessionId &&
				url.get("sessionId") === target.sessionId &&
				url.get("workspace") === target.workspace
			) {
				pending.current = null;
				setDesktopNavigationPending(false);
			}
		};
		const stopChat = useChatStore.subscribe(finishNavigation);
		void listen<DesktopNavigation>("desktop:navigate", ({ payload }) => {
			const target: { sessionId: string; workspace?: string } = { sessionId: payload.sessionId };
			pending.current = target;
			setDesktopNavigationPending(true);
			void listWorkspaces()
				.then(({ workspaces }) => {
					if (closed || pending.current !== target) return;
					const project = workspaces.find((item) => item.path === payload.workspace);
					if (!project) throw new Error("该会话的项目已不可用");
					target.workspace = project.encoded;
					const query = new URLSearchParams({
						workspace: project.encoded,
						sessionId: payload.sessionId,
					});
					navigate(`/chat?${query}`);
					finishNavigation();
				})
				.catch((error) => {
					if (!closed && pending.current === target) {
						pending.current = null;
						setDesktopNavigationPending(false);
						toast.error(String(error));
					}
				});
		})
			.then((dispose) => {
				if (closed) dispose();
				else unlisten = dispose;
			})
			.catch((error) => {
				if (!closed) toast.error(String(error));
			});
		void listen<DesktopNotificationWarning>("desktop:notification-warning", ({ payload }) => {
			if (!closed) toast.warning(payload.message, { id: "desktop-notification-warning" });
		})
			.then((dispose) => {
				if (closed) dispose();
				else unlistenWarning = dispose;
			})
			.catch(() => undefined);
		return () => {
			closed = true;
			stopChat();
			unlisten?.();
			unlistenWarning?.();
			pending.current = null;
			setDesktopNavigationPending(false);
		};
	}, [navigate]);
	return null;
}
