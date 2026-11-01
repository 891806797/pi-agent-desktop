import { expect, test } from "bun:test";
import type { HistoryResponse } from "@pi-agent/common";
import { ApiError } from "../src/lib/api";
import { SessionConnection } from "../src/lib/session-connection";
import type { ChatSseClient, SseHandlers } from "../src/lib/sse-client";

const snapshot = {
	sessionId: "s",
	workspace: "w",
	messages: [],
	seq: 4,
	status: "idle",
	isCompacting: false,
	model: null,
	thinkingLevel: "off",
	availableThinkingLevels: ["off"],
	runMode: "standard",
	queue: { steering: [], followUp: [] },
	pendingApprovals: [],
} as HistoryResponse;
function harness(history: () => Promise<HistoryResponse>) {
	const loads: HistoryResponse[] = [];
	const errors: unknown[] = [];
	const streams: Array<{
		handlers: SseHandlers;
		seq: number;
		closed: boolean;
		start: () => void;
		stop: () => void;
	}> = [];
	const events: unknown[] = [];
	let resumes = 0;
	let requests = 0;
	const c = new SessionConnection(
		{ sessionId: "s", workspace: "w" },
		{
			history: async () => {
				requests++;
				return history();
			},
			resume: async () => {
				resumes++;
				return { sessionId: "s", live: true };
			},
			load: (h) => loads.push(h),
			event: (e) => {
				events.push(e);
			},
			error: (e) => errors.push(e),
			createClient: (_sid, _ws, handlers, seq) => {
				const stream = {
					handlers,
					seq,
					closed: false,
					start() {},
					stop() {
						this.closed = true;
					},
				};
				streams.push(stream);
				return stream as unknown as ChatSseClient;
			},
		},
	);
	return {
		events,
		c,
		loads,
		errors,
		streams,
		get resumes() {
			return resumes;
		},
		get requests() {
			return requests;
		},
	};
}
test("concurrent recovery shares one snapshot and subscription", async () => {
	let resolve!: (h: HistoryResponse) => void;
	const x = harness(() => new Promise((r) => (resolve = r)));
	const a = x.c.recover(),
		b = x.c.recover();
	expect(a).toBe(b);
	expect(x.requests).toBe(1);
	resolve(snapshot);
	await a;
	expect(x.loads).toHaveLength(1);
	expect(x.streams).toHaveLength(1);
	x.c.close();
});
test("closed session discards asynchronous snapshot and subscription", async () => {
	let resolve!: (h: HistoryResponse) => void;
	const x = harness(() => new Promise((r) => (resolve = r)));
	const p = x.c.recover();
	x.c.close();
	resolve(snapshot);
	await p;
	expect(x.loads).toHaveLength(0);
	expect(x.streams).toHaveLength(0);
});
test("server restart resumes only missing session through same snapshot path", async () => {
	let missing = true;
	const x = harness(async () => {
		if (missing) {
			missing = false;
			throw new ApiError(404, "NOT_FOUND", "gone");
		}
		return snapshot;
	});
	await x.c.recover();
	expect(x.resumes).toBe(1);
	expect(x.loads).toHaveLength(1);
	expect(x.streams[0].seq).toBe(4);
	x.c.close();
});
test("forbidden session never creates or resumes replacement", async () => {
	const x = harness(async () => {
		throw new ApiError(403, "FORBIDDEN", "no");
	});
	await x.c.recover();
	expect(x.resumes).toBe(0);
	expect(x.errors).toHaveLength(1);
	expect(x.loads).toHaveLength(0);
	x.c.close();
});
test("resync closes old subscription before snapshot request", async () => {
	const x = harness(async () => snapshot);
	await x.c.recover();
	const first = x.streams[0];
	first.handlers.onResync();
	await x.c.recover();
	expect(first.closed).toBe(true);
	expect(x.streams).toHaveLength(2);
	x.c.close();
});

test("callbacks retained by an old stream cannot mutate the replacement snapshot", async () => {
	const x = harness(async () => snapshot);
	await x.c.recover();
	const old = x.streams[0];
	await x.c.recover();
	old.handlers.onEvent({ seq: 5, event: "status", data: { status: "responding" } });
	expect(x.events).toHaveLength(0);
	x.c.close();
});
