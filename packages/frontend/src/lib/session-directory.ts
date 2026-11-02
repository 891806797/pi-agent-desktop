import type { SequencedUserEvent } from "@pi-agent/common";
import { toast } from "sonner";
import { useChatStore } from "@/stores/chat";
import { useSessionsStore } from "@/stores/sessions";
import { listCatalog } from "./api";
import { type EventSourceTransport, openEventSource } from "./shared-event-source";

/** 独立于聊天坐标，注销后所有异步回调作废。 */
export class SessionDirectory {
	private closed = false;
	private stream: EventSourceTransport | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private watchdog: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	async start(): Promise<void> {
		if (this.closed) return;
		this.stream?.close();
		clearTimeout(this.timer);
		clearTimeout(this.watchdog);
		const generation = ++this.generation;
		const current = () => !this.closed && generation === this.generation;
		try {
			const snapshot = await listCatalog();
			if (!current()) return;
			useSessionsStore.getState().load(snapshot);
			if (typeof SharedWorker === "undefined") {
				this.timer = setTimeout(() => {
					void this.start();
				}, 2000);
				return;
			}
			let seq = snapshot.seq;
			const stream = openEventSource(
				`/api/user/events?epoch=${encodeURIComponent(snapshot.epoch)}&sinceSeq=${seq}`,
				["session_updated", "session_removed", "resync", "error", "heartbeat"],
			);
			this.stream = stream;
			const retry = () => {
				if (!current()) return;
				stream.close();
				clearTimeout(this.watchdog);
				this.timer = setTimeout(() => {
					void this.start();
				}, 1000);
			};
			const alive = () => {
				clearTimeout(this.watchdog);
				this.watchdog = setTimeout(retry, 40000);
			};
			for (const name of ["session_updated", "session_removed"])
				stream.addEventListener(name, (event) => {
					if (!current()) return;
					try {
						const frame = JSON.parse((event as MessageEvent).data) as SequencedUserEvent;
						if (frame.epoch !== snapshot.epoch || frame.seq > seq + 1) {
							retry();
							return;
						}
						if (frame.seq <= seq) return;
						const old =
							frame.event === "session_updated"
								? useSessionsStore.getState().rows[frame.data.sessionId]
								: undefined;
						seq = frame.seq;
						useSessionsStore.getState().apply(frame);
						if (
							frame.event === "session_updated" &&
							old &&
							frame.data.noticeVersion > old.noticeVersion &&
							!(
								frame.data.noticeKind === "notification" &&
								useChatStore.getState().sessionId === frame.data.sessionId
							) &&
							document.visibilityState === "visible"
						) {
							const label =
								frame.data.noticeKind === "failed"
									? "任务未完成，需要处理"
									: frame.data.noticeKind === "attention"
										? "有请求等待你处理"
										: frame.data.noticeKind === "notification"
											? "有扩展通知"
											: "任务已完成";
							toast(`${frame.data.name || frame.data.firstMessage || "会话"}：${label}`, {
								id: `${frame.data.sessionId}:${frame.data.noticeVersion}`,
							});
						}
						alive();
					} catch {
						retry();
					}
				});
			stream.addEventListener("resync", retry);
			stream.addEventListener("error", retry);
			stream.addEventListener("heartbeat", alive);
			alive();
		} catch (error) {
			if (!current()) return;
			useSessionsStore.setState({ error: error instanceof Error ? error.message : String(error) });
			this.timer = setTimeout(() => {
				void this.start();
			}, 2000);
		}
	}
	close() {
		this.closed = true;
		this.generation++;
		clearTimeout(this.timer);
		clearTimeout(this.watchdog);
		this.stream?.close();
		useSessionsStore.getState().reset();
	}
}
