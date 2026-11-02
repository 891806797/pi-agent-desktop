import type { SequencedEvent, SSEEvent } from "@pi-agent/common";
import { RESYNC_MESSAGE } from "@pi-agent/common";
import { type EventSourceTransport, openEventSource } from "./shared-event-source";

const WATCHDOG_MS = 40_000;
export interface SseHandlers {
	onEvent: (ev: SequencedEvent) => void;
	onResync: () => void;
}
export class ChatSseClient {
	private es: EventSourceTransport | null = null;
	private watchdog: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private lastSeq: number;
	constructor(
		private sessionId: string,
		private workspace: string,
		private handlers: SseHandlers,
		sinceSeq = 0,
		private epoch?: string,
	) {
		this.lastSeq = sinceSeq;
	}
	start(): void {
		if (this.closed) return;
		this.stopStream();
		let es: EventSourceTransport;
		const recover = () => {
			if (this.es !== es || this.closed) return;
			this.stopStream();
			this.handlers.onResync();
		};
		const names = [
			"session",
			"commands",
			"status",
			"message_start",
			"text_chunk",
			"thinking_chunk",
			"tool_call_start",
			"tool_call_args",
			"tool_call_end",
			"tool_result",
			"tool_result_partial",
			"retry",
			"user_bash_output",
			"user_message",
			"message_end",
			"usage",
			"session_metrics",
			"run_issue",
			"extension_ui",
			"extension_notify",
			"system_message",
			"approval_request",
			"approval_settled",
			"queue_update",
			"thinking_level_changed",
			"model_changed",
			"run_mode",
			"compaction",
			"session_name",
			"error",
			"turn_end",
			"query_closed",
			"heartbeat",
		] as const;
		es = openEventSource(
			`/api/sessions/${encodeURIComponent(this.sessionId)}/events?workspace=${encodeURIComponent(this.workspace)}&sinceSeq=${this.lastSeq}${this.epoch ? `&epoch=${encodeURIComponent(this.epoch)}` : ""}`,
			names,
		);
		this.es = es;
		for (const name of names)
			es.addEventListener(name, (e) => {
				if (this.es !== es || this.closed) return;
				this.resetWatchdog();
				const frame = e as MessageEvent;
				if (name === "error" && frame.data === undefined) {
					recover();
					return;
				}
				try {
					const data = typeof frame.data === "string" ? JSON.parse(frame.data) : frame.data;
					if (name === "heartbeat") return;
					if (name === "error" && data?.message === RESYNC_MESSAGE) {
						recover();
						return;
					}
					const seq = Number(frame.lastEventId) || 0;
					if (seq > 0) {
						if (seq <= this.lastSeq) return;
						if (seq !== this.lastSeq + 1) {
							recover();
							return;
						}
						this.lastSeq = seq;
					}
					this.handlers.onEvent({ seq, event: name, data } as SequencedEvent);
					if (name === "query_closed") this.stop();
				} catch {
					recover();
				}
			});
		es.onopen = () => {
			if (this.es === es) this.resetWatchdog();
		};
		this.resetWatchdog();
	}
	private resetWatchdog(): void {
		if (this.watchdog) clearTimeout(this.watchdog);
		this.watchdog = setTimeout(() => this.start(), WATCHDOG_MS);
	}
	stop(): void {
		this.closed = true;
		this.stopStream();
	}
	private stopStream(): void {
		if (this.watchdog) clearTimeout(this.watchdog);
		this.watchdog = null;
		this.es?.close();
		this.es = null;
	}
}
export type { SSEEvent };
