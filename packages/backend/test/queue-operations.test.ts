import { describe, expect, test } from "bun:test";
import type { SendMessageInput } from "@pi-agent/common/dto/requests";
import {
	abortRun,
	clearQueue,
	removeQueueItem,
	sendMessage as sendInput,
} from "../src/modules/agent/agent.service";
import { queueSnapshot } from "../src/modules/agent/queue-operations";

const sendMessage = (ctx: SessionContext, input: SendMessageInput) =>
	sendInput(ctx, { behavior: "steer", ...input });

import type { SessionContext } from "../src/modules/agent/session-registry";

function fixture() {
	let steering: string[] = [],
		followUp: string[] = [];
	let listeners: Array<(event: never) => void> = [];
	const calls: Array<{ text: string; images?: unknown }> = [];
	const events: Array<{ event: string; data: unknown }> = [];
	let beforeQueue: (() => Promise<void>) | undefined;
	let failures = 0;
	const emit = () => {
		for (const fn of listeners) fn({ type: "queue_update", steering, followUp } as never);
	};
	const enqueue = async (text: string, images: unknown, behavior: string) => {
		if (beforeQueue) await beforeQueue();
		if (failures > 0) {
			failures--;
			throw new Error("queue failed");
		}
		(behavior === "steer" ? steering : followUp).push(text);
		calls.push({ text, images });
		emit();
	};
	const session = {
		isCompacting: false,
		subscribe: (fn: (event: never) => void) => {
			listeners.push(fn);
			return () => {
				listeners = listeners.filter((f) => f !== fn);
			};
		},
		getSteeringMessages: () => steering,
		getFollowUpMessages: () => followUp,
		prompt: async (
			text: string,
			opts: { images?: unknown; streamingBehavior: string; preflightResult: (d: string) => void },
		) => {
			await enqueue(text, opts.images, opts.streamingBehavior);
			opts.preflightResult("queued");
		},
		clearQueue: () => {
			steering = [];
			followUp = [];
			emit();
		},
		steer: (text: string, images: unknown) => enqueue(text, images, "steer"),
		followUp: (text: string, images: unknown) => enqueue(text, images, "followUp"),
		abort: async () => {},
	};
	const ctx = {
		session,
		cwd: process.cwd(),
		approvals: { rejectAll() {} },
		bus: {
			publish(event: { event: string; data: unknown }) {
				events.push(event);
			},
		},
	} as unknown as SessionContext;
	return {
		ctx,
		calls,
		events,
		queues: () => ({ steering, followUp }),
		consume: () => {
			steering.shift();
			emit();
		},
		fail: (count = 1) => {
			failures = count;
		},
		pause: (hook?: () => Promise<void>) => {
			beforeQueue = hook;
		},
	};
}
const image = (data: string) => [{ type: "image" as const, data, mimeType: "image/png" as const }];

describe("queue transactions", () => {
	test("same text retains each item's own images across edit", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "same", images: image("first") });
		await sendMessage(f.ctx, { text: "same", images: image("second") });
		await sendMessage(f.ctx, { text: "remove" });
		f.calls.length = 0;
		await removeQueueItem(f.ctx, 2, "steer");
		expect(f.calls).toEqual([
			{ text: "same", images: image("first") },
			{ text: "same", images: image("second") },
		]);
	});

	test.each(["clear", "abort"])("%s waits for an in-flight queue edit", async (action) => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "remove" });
		await sendMessage(f.ctx, { text: "keep" });
		let release!: () => void, started!: () => void;
		const entered = new Promise<void>((r) => {
			started = r;
		});
		f.pause(() => {
			f.pause();
			started();
			return new Promise<void>((r) => {
				release = r;
			});
		});
		const edit = removeQueueItem(f.ctx, 0, "steer");
		await entered;
		const clearing = action === "clear" ? clearQueue(f.ctx) : abortRun(f.ctx);
		release();
		await Promise.all([edit, clearing]);
		expect(f.queues()).toEqual({ steering: [], followUp: [] });
	});

	test("send waits behind edit and keeps append order", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "remove" });
		await sendMessage(f.ctx, { text: "keep" });
		const edit = removeQueueItem(f.ctx, 0, "steer");
		const sent = sendMessage(f.ctx, { text: "new" });
		await Promise.all([edit, sent]);
		expect(f.queues().steering).toEqual(["keep", "new"]);
	});

	test("stale index/text leave the current queue unchanged", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "current" });
		await expect(removeQueueItem(f.ctx, 0, "steer", undefined, "old")).rejects.toThrow(
			"队列已更新",
		);
		await expect(removeQueueItem(f.ctx, 9, "steer")).rejects.toThrow("队列条目不存在");
		expect(f.queues().steering).toEqual(["current"]);
	});

	test("failed rebuild restores both tracks with attachments", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "remove" });
		await sendMessage(f.ctx, { text: "keep", images: image("first") });
		await sendMessage(f.ctx, { text: "later", behavior: "followUp" });
		f.fail();
		await expect(removeQueueItem(f.ctx, 0, "steer")).rejects.toThrow("queue failed");
		expect(f.queues()).toEqual({ steering: ["remove", "keep"], followUp: ["later"] });
		expect(f.calls.at(-2)).toEqual({ text: "keep", images: image("first") });
	});

	test("slash text that could expand again is rejected before any destructive edit", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "remove" });
		await sendMessage(f.ctx, { text: "/expanded" });
		await expect(removeQueueItem(f.ctx, 0, "steer")).rejects.toThrow();
		expect(f.queues().steering).toEqual(["remove", "/expanded"]);
	});

	test("SDK consumption removes the first duplicate's metadata", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "same", images: image("first") });
		await sendMessage(f.ctx, { text: "same", images: image("second") });
		f.consume();
		await sendMessage(f.ctx, { text: "remove" });
		f.calls.length = 0;
		await removeQueueItem(f.ctx, 1, "steer");
		expect(f.calls).toEqual([{ text: "same", images: image("second") }]);
	});

	test("stale revision cannot delete the next same-text item with different images", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "same", images: image("first") });
		await sendMessage(f.ctx, { text: "same", images: image("second") });
		const revision = queueSnapshot(f.ctx).revision;
		f.consume();
		await expect(removeQueueItem(f.ctx, 0, "steer", undefined, "same", revision)).rejects.toThrow(
			"队列已更新",
		);
		expect(f.queues().steering).toEqual(["same"]);
		await sendMessage(f.ctx, { text: "remove" });
		f.calls.length = 0;
		await removeQueueItem(f.ctx, 1, "steer", undefined, "remove", queueSnapshot(f.ctx).revision);
		expect(f.calls).toEqual([{ text: "same", images: image("second") }]);
	});

	test("SDK consumption during rebuild reports conflict instead of replaying consumed input", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "remove" });
		await sendMessage(f.ctx, { text: "one" });
		await sendMessage(f.ctx, { text: "two" });
		await sendMessage(f.ctx, { text: "three", images: image("third") });
		await sendMessage(f.ctx, { text: "other-track", behavior: "followUp", images: image("other") });
		let calls = 0;
		f.pause(async () => {
			if (++calls === 2) f.consume();
		});
		await expect(removeQueueItem(f.ctx, 0, "steer")).rejects.toThrow("智能体已消费队列");
		expect(f.queues()).toEqual({ steering: ["two", "three"], followUp: ["other-track"] });
		expect(f.calls.at(-2)).toEqual({ text: "three", images: image("third") });
		expect(f.calls.at(-1)).toEqual({ text: "other-track", images: image("other") });
	});

	test("permanent SDK failure explicitly reports incomplete recovery", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "remove" });
		await sendMessage(f.ctx, { text: "keep" });
		f.fail(2);
		await expect(removeQueueItem(f.ctx, 0, "steer")).rejects.toThrow("恢复未完成");
	});

	test("closing during edit prevents remaining reinsertions and rollback", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "remove" });
		await sendMessage(f.ctx, { text: "one" });
		await sendMessage(f.ctx, { text: "two" });
		f.calls.length = 0;
		f.pause(async () => {
			f.ctx.closing = true;
		});
		await expect(removeQueueItem(f.ctx, 0, "steer")).rejects.toThrow("会话正在关闭");
		expect(f.calls.map((call) => call.text)).toEqual(["one"]);
	});

	test("consumption followed by SDK failure retains both-track suffix and retries before new send", async () => {
		const f = fixture();
		for (const text of ["remove", "one", "two", "three"])
			await sendMessage(f.ctx, { text, images: image(text) });
		await sendMessage(f.ctx, { text: "other-track", behavior: "followUp", images: image("other") });
		let calls = 0;
		f.pause(async () => {
			if (++calls === 2) {
				f.consume();
				f.fail();
				f.pause();
			}
		});
		await expect(removeQueueItem(f.ctx, 0, "steer")).rejects.toThrow("保留 3 条待恢复");
		expect(f.queues()).toEqual({ steering: [], followUp: [] });
		expect(queueSnapshot(f.ctx)).toMatchObject({
			steering: ["two", "three"],
			followUp: ["other-track"],
		});
		expect(f.events.at(-2)).toEqual({ event: "queue_update", data: queueSnapshot(f.ctx) });
		await sendMessage(f.ctx, { text: "new" });
		expect(f.queues()).toEqual({ steering: ["two", "three", "new"], followUp: ["other-track"] });
		expect(f.calls.slice(-4, -1)).toEqual([
			{ text: "two", images: image("two") },
			{ text: "three", images: image("three") },
			{ text: "other-track", images: image("other") },
		]);
	});

	test.each(["clear", "abort"])(
		"%s discards retained recovery without retrying SDK",
		async (action) => {
			const f = fixture();
			await sendMessage(f.ctx, { text: "remove" });
			await sendMessage(f.ctx, { text: "keep" });
			f.fail(100);
			await expect(removeQueueItem(f.ctx, 0, "steer")).rejects.toThrow("保留 2 条待恢复");
			expect(queueSnapshot(f.ctx).steering).toEqual(["remove", "keep"]);
			if (action === "clear") await clearQueue(f.ctx);
			else await abortRun(f.ctx);
			expect(queueSnapshot(f.ctx)).toMatchObject({ steering: [], followUp: [] });
		},
	);

	test("editing first restores saved entries, without losing their images", async () => {
		const f = fixture();
		await sendMessage(f.ctx, { text: "remove" });
		await sendMessage(f.ctx, { text: "keep", images: image("keep") });
		f.fail(2);
		await expect(removeQueueItem(f.ctx, 0, "steer")).rejects.toThrow("保留 2 条待恢复");
		await removeQueueItem(f.ctx, 0, "steer", "followUp", "remove");
		expect(f.queues()).toEqual({ steering: ["keep"], followUp: ["remove"] });
		expect(f.calls.at(-2)).toEqual({ text: "keep", images: image("keep") });
	});
});
