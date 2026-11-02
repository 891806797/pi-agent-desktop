import { useEffect } from "react";
import { readSession } from "@/lib/api";
import { isPageVisible } from "@/lib/desktop";
import { SessionDirectory } from "@/lib/session-directory";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { useSessionsStore } from "@/stores/sessions";

export function useSessionDirectory() {
	const username = useAuthStore((state) => state.username);
	useEffect(() => {
		if (!username) return;
		const connection = new SessionDirectory();
		let closed = false;
		const reading = new Map<string, number>();
		const markRead = () => {
			if (closed || !isPageVisible()) return;
			const chat = useChatStore.getState();
			if (
				!chat.sessionId ||
				chat.isSwitchingSession ||
				location.pathname !== "/chat" ||
				new URLSearchParams(location.search).get("sessionId") !== chat.sessionId
			)
				return;
			const row = useSessionsStore.getState().rows[chat.sessionId];
			if (
				!row ||
				row.noticeVersion <= row.readVersion ||
				row.sessionEpoch !== chat.epoch ||
				(row.sessionSeq ?? Infinity) > chat.lastSeq ||
				(reading.get(row.sessionId) ?? 0) >= row.noticeVersion
			)
				return;
			reading.set(row.sessionId, row.noticeVersion);
			void readSession(row.sessionId, row.noticeVersion).catch(() => {
				if (!closed) reading.delete(row.sessionId);
			});
		};
		const stopChat = useChatStore.subscribe(markRead);
		const stopDirectory = useSessionsStore.subscribe(markRead);
		document.addEventListener("visibilitychange", markRead);
		window.addEventListener("desktop:visibilitychange", markRead);
		void connection.start();
		return () => {
			closed = true;
			stopChat();
			stopDirectory();
			document.removeEventListener("visibilitychange", markRead);
			window.removeEventListener("desktop:visibilitychange", markRead);
			connection.close();
		};
	}, [username]);
}
