import { describe, expect, test } from "bun:test";
import { SessionEventBus } from "@/modules/agent/event-bus";

describe("SessionEventBus", () => {
	test("服务重启后旧游标大于当前序号必须重新对账", () => {
		const bus = new SessionEventBus();
		bus.publish({ event: "status", data: { status: "idle" } });
		expect(bus.replaySince(99)).toBeUndefined();
	});
	test("publish 定序单调且广播给所有订阅者", () => {
		const bus = new SessionEventBus();
		const a: number[] = [];
		const b: number[] = [];
		const unsubA = bus.subscribe((ev) => a.push(ev.seq));
		bus.subscribe((ev) => b.push(ev.seq));

		bus.publish({ event: "status", data: { status: "idle" } });
		bus.publish({ event: "status", data: { status: "thinking" } });

		expect(a).toEqual([1, 2]);
		expect(b).toEqual([1, 2]);
		unsubA();
		bus.publish({ event: "status", data: { status: "idle" } });
		expect(a).toEqual([1, 2]);
		expect(b).toEqual([1, 2, 3]);
	});

	test("replaySince 增量重放", () => {
		const bus = new SessionEventBus();
		for (let i = 0; i < 10; i++) bus.publish({ event: "status", data: { status: "idle" } });
		expect(bus.replaySince(0)).toEqual([]);
		expect(bus.replaySince(10)).toEqual([]);
		const replay = bus.replaySince(7);
		expect(replay?.map((e) => e.seq)).toEqual([8, 9, 10]);
	});

	test("环形缓冲溢出后 replaySince 返回 undefined（跳洞信号）", () => {
		const bus = new SessionEventBus();
		for (let i = 0; i < 600; i++) bus.publish({ event: "status", data: { status: "idle" } });
		expect(bus.replaySince(1)).toBeUndefined();
		// 缓冲窗口内的锚点仍可增量重放
		const anchor = bus.currentSeq - 10;
		expect(bus.replaySince(anchor)?.length).toBe(10);
	});
});
