import type { HistoryResponse } from "@pi-agent/common";
import { useChatStore } from "@/stores/chat";
import * as api from "./api";
import { ChatSseClient } from "./sse-client";

/** Owns one URL session. Closing invalidates in-flight snapshots and all stream callbacks. */
export class SessionConnection {
	private closed = false;
	private generation = 0;
	private client: ChatSseClient | null = null;
	private recovering: Promise<void> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	constructor(
		private coords: api.SessionCoordinates,
		private deps = {
			history: api.history,
			resume: api.createSession,
			createClient: (
				sid: string,
				ws: string,
				handlers: ConstructorParameters<typeof ChatSseClient>[2],
				seq: number,
			) => new ChatSseClient(sid, ws, handlers, seq),
			load: (h: HistoryResponse) => useChatStore.getState().loadSnapshot(h),
			event: useChatStore.getState().applyEvent,
			error: (err: unknown) =>
				useChatStore.setState({
					isSwitchingSession: false,
					lastError: err instanceof Error ? err.message : String(err),
				}),
		},
	) {}
	recover(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.recovering) return this.recovering;
		this.client?.stop();
		this.client = null;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.recovering = this.run(++this.generation)
			.catch((err) => {
				if (!this.closed) {
					this.deps.error(err);
					if (!(err instanceof api.ApiError) || err.status >= 500)
						this.retryTimer = setTimeout(() => {
							void this.recover();
						}, 2000);
				}
			})
			.finally(() => {
				this.recovering = null;
			});
		return this.recovering;
	}
	private async run(generation: number) {
		let h: HistoryResponse;
		try {
			h = await this.deps.history(this.coords);
		} catch (err) {
			if (this.closed) return;
			if (!(err instanceof api.ApiError) || err.status !== 404) throw err;
			await this.deps.resume(this.coords.workspace, this.coords.sessionId);
			if (this.closed) return;
			h = await this.deps.history(this.coords);
		}
		if (this.closed) return;
		this.deps.load(h);
		this.client = this.deps.createClient(
			this.coords.sessionId,
			this.coords.workspace,
			{
				onEvent: (e) => {
					if (!this.closed && generation === this.generation) this.deps.event(e);
				},
				onResync: () => {
					if (this.closed || generation !== this.generation) return;
					void this.recover();
				},
			},
			h.seq,
		);
		this.client.start();
	}
	close() {
		this.closed = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.client?.stop();
		this.client = null;
	}
}
