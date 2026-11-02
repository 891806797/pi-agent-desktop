import { expect } from "bun:test";
import { createChatScroll } from "../../src/hooks/useChatScroll";

const frames = new Map<number, FrameRequestCallback>();
let id = 0;
let time = 0;
let writes = 0;
let reads = 0;
let top = 0;
let height = 1000;
let viewport = 400;
let resize: () => void = () => {};
const motion = { matches: false };
const scroll = Object.assign(new EventTarget(), { closest: () => null });
Object.defineProperties(scroll, {
	scrollTop: {
		get: () => top,
		set: (value: number) => {
			writes++;
			top = value;
		},
	},
	scrollHeight: {
		get: () => {
			reads++;
			return height;
		},
	},
	clientHeight: {
		get: () => {
			reads++;
			return viewport;
		},
	},
});
Object.assign(globalThis, {
	window: { matchMedia: () => motion },
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		frames.set(++id, callback);
		return id;
	},
	cancelAnimationFrame: (key: number) => {
		frames.delete(key);
	},
	ResizeObserver: class {
		constructor(callback: () => void) {
			resize = callback;
		}
		observe() {}
		disconnect() {}
	},
});
const changes: boolean[] = [];
const controller = createChatScroll(scroll as unknown as HTMLElement, {} as HTMLElement, (value) =>
	changes.push(value),
);
controller.resume(true);
expect(top).toBe(600);
height = 1400;
for (let index = 0; index < 20; index++) resize();
expect(frames.size).toBe(1);
const readBeforeFrames = reads;
const advance = () => {
	const queued = [...frames.values()];
	frames.clear();
	time += 16.7;
	const before = writes;
	queued.forEach((callback) => {
		callback(time);
	});
	expect(writes - before).toBeLessThanOrEqual(1);
	scroll.dispatchEvent(new Event("scroll"));
};
advance();
expect(top).toBeGreaterThan(600);
expect(top).toBeLessThan(1000);
for (let index = 0; index < 80 && frames.size; index++) advance();
expect(top).toBe(1000);
expect(reads).toBe(readBeforeFrames);
expect(frames.size).toBe(0);
scroll.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -1, deltaX: 0 }));
expect(changes).toEqual([false]);
height = 1800;
resize();
expect(frames.size).toBe(0);
expect(top).toBe(1000);
controller.resume();
expect(changes).toEqual([false, true]);
expect(frames.size).toBe(1);
motion.matches = true;
advance();
expect(top).toBe(1400);
expect(frames.size).toBe(0);
viewport = 200;
resize();
advance();
expect(top).toBe(1600);
height = 2000;
resize();
expect(frames.size).toBe(1);
controller.destroy();
expect(frames.size).toBe(0);
