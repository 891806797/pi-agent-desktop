import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import * as api from "@/lib/api";
import { SessionConnection } from "@/lib/session-connection";
import { useChatStore } from "@/stores/chat";

export function useChatAgent(): void {
	const { search } = useLocation();
	const navigate = useNavigate();
	const params = new URLSearchParams(search);
	const workspace = params.get("workspace") ?? "";
	const sessionId = params.get("sessionId") ?? "";
	useEffect(() => {
		let cancelled = false;
		useChatStore.getState().reset();
		if (!workspace) {
			void api
				.listWorkspaces()
				.then((r) => {
					if (!cancelled)
						navigate(r.workspaces[0] ? `/chat?workspace=${r.workspaces[0].encoded}` : "/settings", {
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
		void connection.recover();
		return () => connection.close();
	}, [workspace, sessionId, navigate]);
}
