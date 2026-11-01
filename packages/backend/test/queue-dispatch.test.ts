import { describe, expect, test } from "bun:test";
import type { QueueDispatchInput } from "@pi-agent/common/dto/requests";
import { sendMessage } from "../src/modules/agent/agent.service";
import { dispatchQueuedMessage, queueSnapshot } from "../src/modules/agent/queue-operations";
import type { SessionContext } from "../src/modules/agent/session-registry";

function fixture() {
	let steering: string[] = [],
		followUp: string[] = [],
		running = true;
	const listeners: Array<(event: never) => void> = [];
	const started: Array<{ text: string; images: unknown }> = [];
	const queued: Array<{ text: string; images: unknown }> = [];
	let userStarted!: () => void;
	const userStart = new Promise<void>((resolve) => {
		userStarted = resolve;
	});
	let abortCount = 0,
		cancelled = 0,
		failAbort = false,
		failPrompt = false,
		failEnqueue = false;
	const emit = () => {
		for (const fn of listeners)
			fn({ type: "queue_update", steering: [...steering], followUp: [...followUp] } as never);
	};
	const enqueue = async (text: string, images: unknown, behavior: string) => {
		if (failEnqueue) {
			failEnqueue = false;
			throw new Error("queue failed");
		}
		(behavior === "steer" ? steering : followUp).push(text);
		queued.push({ text, images });
		emit();
	};
	const session = {
		get isIdle() {
			return !running;
		},
		isCompacting: false,
		isBashRunning: false,
		subscribe: (fn: (event: never) => void) => {
			listeners.push(fn);
			return () => {};
		},
		getSteeringMessages: () => steering,
		getFollowUpMessages: () => followUp,
		clearQueue: () => {
			steering = [];
			followUp = [];
			emit();
		},
		steer: (text: string, images: unknown) => enqueue(text, images, "steer"),
		followUp: (text: string, images: unknown) => enqueue(text, images, "followUp"),
		abort: async () => {
			abortCount++;
			if (failAbort) throw new Error("abort failed");
			running = false;
		},
		prompt: async (
			text: string,
			opts: {
				images: unknown;
				streamingBehavior: string;
				preflightResult: (disposition: string) => void;
			},
		) => {
			if (failPrompt) throw new Error("prompt failed");
			if (running) {
				await enqueue(text, opts.images, opts.streamingBehavior);
				opts.preflightResult("queued");
				return;
			}
			running = true;
			started.push({ text, images: opts.images });
			opts.preflightResult("started");
			await Bun.sleep(0);
			// SDK 在最初的 user message_start 也按文本移除队列匹配项。
			const steeringIndex = steering.indexOf(text),
				followUpIndex = followUp.indexOf(text);
			if (steeringIndex >= 0) {
				steering.splice(steeringIndex, 1);
				emit();
			} else if (followUpIndex >= 0) {
				followUp.splice(followUpIndex, 1);
				emit();
			}
			for (const fn of listeners)
				fn({ type: "message_start", message: { role: "user", content: text } } as never);
			userStarted();
			await new Promise(() => {});
		},
	};
	const ctx = {
		session,
		cwd: process.cwd(),
		approvals: {
			rejectAll() {
				cancelled++;
			},
		},
		bus: { publish() {} },
	} as unknown as SessionContext;
	return {
		ctx,
		started,
		queued,
		userStart,
		idle: () => {
			running = false;
		},
		counts: () => ({ abortCount, cancelled }),
		failEnqueue: () => {
			failEnqueue = true;
		},
		failAbort: (value = true) => {
			failAbort = value;
		},
		failPrompt: (value = true) => {
			failPrompt = value;
		},
		consume: () => {
			followUp.shift();
			emit();
		},
	};
}
const images = (data: string) => [{ type: "image" as const, data, mimeType: "image/png" as const }];
function input(
	ctx: SessionContext,
	behavior: "steer" | "followUp",
	index: number,
	mode: "steer" | "stop",
): QueueDispatchInput {
	const queue = queueSnapshot(ctx);
	return {
		requestId: crypto.randomUUID(),
		behavior,
		index,
		mode,
		expectedText: (behavior === "steer" ? queue.steering : queue.followUp)[index]!,
		revision: queue.revision!,
	};
}

describe("queue immediate dispatch", () => {
	test("stop and send waits for the interrupted recovery task before starting a new prompt", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "selected" });
		let release!: () => void;
		let cancelled = false;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.ctx.recovery = {
			cancel: () => {
				cancelled = true;
			},
			wait: () => waiting,
			beginInput: () => undefined,
		} as unknown as NonNullable<SessionContext["recovery"]>;
		const operation = dispatchQueuedMessage(f.ctx, input(f.ctx, "followUp", 0, "stop"));
		await Bun.sleep(20);
		try {
			expect(cancelled).toBe(true);
			expect(f.started).toEqual([]);
		} finally {
			release();
			await operation;
		}
		expect(f.started).toHaveLength(1);
	});
	test("streaming input defaults to followUp", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "later" });
		expect(queueSnapshot(f.ctx).followUp).toEqual(["later"]);
	});
	test("stop and send cancels approvals and preserves other tracks/images without waiting for full run", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "same", behavior: "followUp", images: images("selected") });
		await sendMessage(f.ctx, { text: "same", behavior: "followUp", images: images("remaining") });
		await sendMessage(f.ctx, { text: "steering", behavior: "steer", images: images("steering") });
		await dispatchQueuedMessage(f.ctx, input(f.ctx, "followUp", 0, "stop"));
		await f.userStart;
		expect(f.counts()).toEqual({ abortCount: 1, cancelled: 1 });
		expect(f.started).toEqual([{ text: "same", images: images("selected") }]);
		expect(queueSnapshot(f.ctx)).toMatchObject({ steering: ["steering"], followUp: ["same"] });
		expect(f.queued.slice(-2)).toEqual([
			{ text: "steering", images: images("steering") },
			{ text: "same", images: images("remaining") },
		]);
	});
	test("non-stop dispatch prioritizes selected input at the next SDK boundary", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "older", behavior: "steer" });
		await sendMessage(f.ctx, { text: "selected", behavior: "followUp" });
		await dispatchQueuedMessage(f.ctx, input(f.ctx, "followUp", 0, "steer"));
		expect(queueSnapshot(f.ctx).steering).toEqual(["selected", "older"]);
		expect(f.counts().abortCount).toBe(0);
	});
	test("two pages dispatching the same snapshot produce a single new prompt", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "selected", behavior: "followUp" });
		const first = input(f.ctx, "followUp", 0, "stop");
		const results = await Promise.allSettled([
			dispatchQueuedMessage(f.ctx, first),
			dispatchQueuedMessage(f.ctx, { ...first, requestId: crypto.randomUUID() }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(f.started).toHaveLength(1);
		await dispatchQueuedMessage(f.ctx, first);
		expect(f.started).toHaveLength(1);
	});
	test("stale revision refuses before abort and preserves remaining inputs", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "selected", behavior: "followUp" });
		await sendMessage(f.ctx, { text: "remaining", behavior: "followUp" });
		const stale = input(f.ctx, "followUp", 0, "stop");
		f.consume();
		await expect(dispatchQueuedMessage(f.ctx, stale)).rejects.toThrow("队列已更新");
		expect(f.counts().abortCount).toBe(0);
		expect(queueSnapshot(f.ctx).followUp).toEqual(["remaining"]);
	});
	test("steer rechecks revision after its awaited edit boundary for same-text items", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "same", images: images("first") });
		await sendMessage(f.ctx, { text: "same", images: images("second") });
		const operation = dispatchQueuedMessage(f.ctx, input(f.ctx, "followUp", 0, "steer"));
		queueMicrotask(() => queueMicrotask(() => f.consume()));
		await expect(operation).rejects.toThrow("队列已更新");
		expect(queueSnapshot(f.ctx)).toMatchObject({ steering: [], followUp: ["same"] });
		expect(f.started).toEqual([]);
	});
	test.each(["abort", "prompt"])("%s failure retains selected and other inputs", async (kind) => {
		const f = fixture();
		await sendMessage(f.ctx, {
			text: "selected",
			behavior: "followUp",
			images: images("selected"),
		});
		await sendMessage(f.ctx, { text: "remaining", behavior: "steer" });
		if (kind === "abort") f.failAbort();
		else f.failPrompt();
		await expect(dispatchQueuedMessage(f.ctx, input(f.ctx, "followUp", 0, "stop"))).rejects.toThrow(
			"保留",
		);
		expect(queueSnapshot(f.ctx)).toMatchObject({ steering: ["remaining"], followUp: ["selected"] });
	});
	test("retrying stop after prompt rejection preserves the selected image and other track", async () => {
		const f = fixture();
		await sendMessage(f.ctx, {
			text: "selected",
			behavior: "followUp",
			images: images("selected"),
		});
		await sendMessage(f.ctx, { text: "remaining", behavior: "steer", images: images("remaining") });
		f.failPrompt();
		await expect(
			dispatchQueuedMessage(f.ctx, input(f.ctx, "followUp", 0, "stop")),
		).rejects.toThrow();
		f.failPrompt(false);
		await dispatchQueuedMessage(f.ctx, input(f.ctx, "followUp", 0, "stop"));
		expect(f.started).toEqual([{ text: "selected", images: images("selected") }]);
		expect(f.queued.at(-1)).toEqual({ text: "remaining", images: images("remaining") });
	});
	test("accepted dispatch is never repeated when restoring another input fails", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "same", behavior: "followUp", images: images("selected") });
		await sendMessage(f.ctx, { text: "same", behavior: "followUp", images: images("remaining") });
		const operation = input(f.ctx, "followUp", 0, "stop");
		f.failEnqueue();
		await expect(dispatchQueuedMessage(f.ctx, operation)).rejects.toThrow("保留 1 条待恢复");
		expect(f.started).toHaveLength(1);
		await expect(dispatchQueuedMessage(f.ctx, operation)).rejects.toThrow();
		await expect(
			dispatchQueuedMessage(f.ctx, { ...operation, requestId: crypto.randomUUID() }),
		).rejects.toThrow("队列已更新");
		expect(f.started).toHaveLength(1);
		expect(queueSnapshot(f.ctx).followUp).toEqual(["same"]);
		await sendMessage(f.ctx, { text: "new" });
		expect(f.queued.at(-2)).toEqual({ text: "same", images: images("remaining") });
	});
	test("an idle queue dispatch starts the selected input rather than leaving it queued", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "selected" });
		f.idle();
		await dispatchQueuedMessage(f.ctx, input(f.ctx, "followUp", 0, "steer"));
		expect(f.started).toHaveLength(1);
	});
});
