import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as api from "@/lib/api";
import { loadPreferences } from "@/lib/default-settings";
import { SessionConnection } from "@/lib/session-connection";
import { useChatStore } from "@/stores/chat";

export async function resolveProjectChatPath(workspace: string): Promise<string> {
	const catalog = await api.listCatalog({ workspace, limit: 1 });
	const query = new URLSearchParams({ workspace });
	if (catalog.sessions[0]) query.set("sessionId", catalog.sessions[0].sessionId);
	return `/chat?${query}`;
}

export function useChatAgent(): void {
	const { search } = useLocation();
	const navigate = useNavigate();
	const params = new URLSearchParams(search);
	const workspace = params.get("workspace") ?? "";
	const sessionId = params.get("sessionId") ?? "";
	useEffect(() => {
		let cancelled = false;
		const current = () => !cancelled && location.search === search;
		useChatStore.getState().reset();
		if (!sessionId)
			void loadPreferences(current).catch((error) => {
				if (current()) useChatStore.setState({ lastError: String(error) });
			});
		if (!workspace) {
			void api
				.listWorkspaces()
				.then(async (r) => {
					const first = r.workspaces[0];
					if (cancelled || !first) return;
					const target = await resolveProjectChatPath(first.encoded);
					if (!cancelled)
						navigate(target, {
							replace: true,
						});
				})
				.catch((err) => {
					if (!cancelled) useChatStore.setState({ lastError: String(err) });
				});
			return () => {
				cancelled = true;
			};
		}
		// An empty sessionId is an intentional new conversation, including when old sessions exist.
		if (!sessionId) return;
		useChatStore.setState({ isSwitchingSession: true });
		const connection = new SessionConnection({ sessionId, workspace });
		// StrictMode 的首次挂载会立即清理；下一微任务再启动，避免发出已失效的历史请求。
		queueMicrotask(() => {
			if (current()) void connection.recover();
		});
		const reconnect = () => {
			void connection.recover();
		};
		window.addEventListener("pi:reconnect", reconnect);
		return () => {
			window.removeEventListener("pi:reconnect", reconnect);
			connection.close();
		};
	}, [workspace, sessionId, navigate, search]);
}
