import { afterAll, expect, test } from "bun:test";

const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const savedSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
const savedConnect = Object.getOwnPropertyDescriptor(globalThis, "onconnect");
class Source {
	static OPEN = 1;
	static instances: Source[] = [];
	readyState = 1;
	closed = false;
	listeners = new Map<string, (event: unknown) => void>();
	onopen?: () => void;
	constructor(public url: URL) {
		Source.instances.push(this);
	}
	addEventListener(name: string, fn: (event: unknown) => void) {
		this.listeners.set(name, fn);
	}
	close() {
		this.closed = true;
	}
}
Object.defineProperty(globalThis, "location", {
	value: { origin: "http://test" },
	configurable: true,
});
Object.defineProperty(globalThis, "EventSource", { value: Source, configurable: true });
await import("../src/lib/sse-worker");
afterAll(() => {
	for (const [name, descriptor] of [
		["location", savedLocation],
		["EventSource", savedSource],
		["onconnect", savedConnect],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});
function connect(sinceSeq: number) {
	const frames: Array<{ name: string; data?: string }> = [];
	const port = {
		onmessage: undefined as undefined | ((event: { data: unknown }) => void),
		onmessageerror: undefined,
		postMessage: (frame: { name: string; data?: string }) => frames.push(frame),
		start() {},
	};
	(globalThis as unknown as { onconnect: (event: { ports: unknown[] }) => void }).onconnect({
		ports: [port],
	});
	port.onmessage!({
		data: {
			action: "open",
			url: `/api/sessions/one/events?workspace=w&epoch=E&sinceSeq=${sinceSeq}`,
			names: ["text_chunk", "error"],
		},
	});
	return { frames, close: () => port.onmessage!({ data: { action: "close" } }) };
}
test("tabs share one physical stream, replay the join gap and closing one tab keeps other subscribers alive", () => {
	const one = connect(0);
	const source = Source.instances[0]!;
	source.listeners.get("text_chunk")!({ data: JSON.stringify({ delta: "one" }), lastEventId: "1" });
	const two = connect(0);
	expect(Source.instances).toHaveLength(1);
	expect(two.frames.some((frame) => frame.data?.includes("one"))).toBe(true);
	const stale = connect(99);
	expect(stale.frames.some((frame) => frame.name === "error")).toBe(true);
	one.close();
	expect(source.closed).toBe(false);
	two.close();
	expect(source.closed).toBe(true);
});
