import { BUILTIN_SLASH_COMMANDS, type SlashCommand } from "@pi-agent/common";
import type { ApprovalActionInput } from "@pi-agent/common/dto/requests";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { Attachment, ChatAgentApi } from "@/lib/agent-types";
import * as api from "@/lib/api";
import { sendToSession } from "@/lib/send-message";
import { useChatStore } from "@/stores/chat";

const RUN_LABEL = { auto: "自动", standard: "标准", safe: "安全", plan: "计划" };

export function useChatAgentApi(opts: { projectId: string | null }): ChatAgentApi {
	const { projectId } = opts;
	const navigate = useNavigate();
	useLocation();
	// BrowserRouter may render its old location while its own navigation is committing.
	// The browser URL already includes our created session and remains the request guard.
	const pageSearch = location.search;
	const page = useRef({ search: pageSearch });
	if (page.current.search !== pageSearch) page.current = { search: pageSearch };
	const pendingModes = useRef(new Map<string, import("@pi-agent/common").RunMode>());
	const sending = useRef<{ page: { search: string } } | null>(null);
	const [sendError, setSendError] = useState<{ page: { search: string }; message: string } | null>(
		null,
	);
	const isCompacting = useChatStore((s) => s.isCompacting);
	const isSwitchingSession = useChatStore((s) => s.isSwitchingSession);
	const storeError = useChatStore((s) => s.lastError);
	const lastError = sendError?.page === page.current ? sendError.message : storeError;
	// 消息与组件共用 common 契约，直接保留 store 中的引用
	const rawMessages = useChatStore((s) => s.messages);
	const messages = rawMessages;
	const status = useChatStore((s) => s.status);
	const closed = useChatStore((s) => s.closed);
	const sessionId = useChatStore((s) => s.sessionId);
	const rawApprovals = useChatStore((s) => s.approvals);
	const approvals = useMemo(() => [...rawApprovals.values()], [rawApprovals]);
	const runMode = useChatStore((s) => s.runMode);
	const [commands, setCommands] = useState<SlashCommand[]>([...BUILTIN_SLASH_COMMANDS]);
	const isCurrentSession = () =>
		!!sessionId &&
		location.search === pageSearch &&
		api.urlSessionId() === sessionId &&
		api.urlWorkspace() === projectId &&
		useChatStore.getState().sessionId === sessionId;

	useEffect(() => {
		let cancelled = false;
		setCommands([...BUILTIN_SLASH_COMMANDS]);
		if (!sessionId) return;
		void api
			.commands()
			.then((r) => {
				if (!cancelled) setCommands(r.commands);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 浏览器 URL 可先于 Router 提交，回调必须绑定本次页面坐标。
	const sendMessage = useCallback(
		async (text: string, attachments?: Attachment[], behavior?: "steer" | "followUp") => {
			if (!projectId || location.search !== pageSearch || sending.current?.page === page.current)
				return false;
			if (text.trim() === "/new") {
				if (attachments?.length) {
					useChatStore.setState({ lastError: "请先新建会话，再发送附件" });
					return false;
				}
				navigate(`/chat?workspace=${encodeURIComponent(projectId)}`, { replace: true });
				return true;
			}
			if (useChatStore.getState().closed) {
				useChatStore.setState({ lastError: "会话已关闭，请刷新或重新打开会话后发送" });
				return false;
			}
			const currentPage = page.current;
			const operation = { page: currentPage };
			const isCurrent = () =>
				page.current === currentPage && location.search === currentPage.search;
			const sid = api.urlSessionId();
			sending.current = operation;
			setSendError(null);
			if (!sid) useChatStore.setState({ isSwitchingSession: true });
			const images = attachments
				?.filter((a) => a.type === "image")
				.map((a) => ({
					type: "image" as const,
					data: a.dataUrl.split(",")[1] ?? "",
					mimeType: a.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
				}));
			return sendToSession(
				{ text, behavior, ...(images?.length ? { images } : {}) },
				projectId,
				sid,
				useChatStore.getState().runMode,
				{
					isCurrent,
					pendingModes: pendingModes.current,
					onCreated: (coords) => {
						currentPage.search = `?workspace=${encodeURIComponent(coords.workspace)}&sessionId=${encodeURIComponent(coords.sessionId)}`;
						navigate(`/chat${currentPage.search}`, { replace: true });
						useChatStore.getState().setSession(coords.sessionId);
					},
				},
			)
				.catch((err) => {
					if (isCurrent()) {
						setSendError({
							page: currentPage,
							message: err instanceof Error ? err.message : String(err),
						});
						useChatStore.setState({ isSwitchingSession: false });
					}
					return false;
				})
				.finally(() => {
					if (sending.current === operation) sending.current = null;
				});
		},
		[projectId, navigate, pageSearch],
	);
	const settle = async (
		requestId: string,
		action: ApprovalActionInput["action"],
		data?: unknown,
	) => {
		if (!isCurrentSession() || !useChatStore.getState().approvals.has(requestId)) return;
		await api.settleApproval(requestId, action, data);
	};

	return {
		messages,
		projectId,
		status,
		isRunning: status !== "idle" && status !== "error",
		isCompacting,
		isSwitchingSession,
		lastError,
		sessionId,
		closed,
		approvalRequests: approvals,
		commands,
		runMode,
		runModeLabel: RUN_LABEL[runMode] ?? runMode,
		selectRunMode: async (m) => {
			if (location.search !== pageSearch || api.urlWorkspace() !== projectId) return;
			const currentSid = api.urlSessionId();
			if (!currentSid) {
				useChatStore.getState().setRunMode(m);
				return;
			}
			const search = location.search;
			try {
				await api.setRunMode(m);
			} catch (err) {
				if (location.search === search)
					useChatStore.setState({ lastError: err instanceof Error ? err.message : String(err) });
				throw err;
			}
		},
		sendMessage,
		interruptRun: () => {
			if (isCurrentSession())
				void api.abortRun().catch((err) => {
					if (isCurrentSession()) useChatStore.setState({ lastError: String(err) });
				});
		},
		approve: settle,
	};
}
