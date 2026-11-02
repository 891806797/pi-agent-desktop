import { isDesktop, openDesktopEventSource } from "./desktop";

export interface EventSourceTransport {
	addEventListener(name: string, handler: (event: Event) => void): void;
	close(): void;
	onopen: ((event: Event) => void) | null;
}

/** 相同会话/用户订阅跨标签页共享，给普通 HTTP 请求保留连接额度。 */
export function openEventSource(url: string, names: readonly string[]): EventSourceTransport {
	if (isDesktop()) return openDesktopEventSource(url);
	if (typeof SharedWorker === "undefined") return new EventSource(url);
	const worker = new SharedWorker(new URL("./sse-worker.ts", import.meta.url), {
		type: "module",
		name: "pi-agent-streams",
	});
	const listeners = new Map<string, Set<(event: Event) => void>>();
	let closed = false;
	const source: EventSourceTransport = {
		onopen: null,
		addEventListener(name, handler) {
			let handlers = listeners.get(name);
			if (!handlers) {
				handlers = new Set();
				listeners.set(name, handlers);
			}
			handlers.add(handler);
		},
		close() {
			if (closed) return;
			closed = true;
			worker.port.postMessage({ action: "close" });
			worker.port.close();
			window.removeEventListener("pagehide", source.close);
		},
	};
	worker.port.onmessage = (message) => {
		if (closed) return;
		const frame = message.data as { name: string; data?: string; lastEventId?: string };
		if (frame.name === "open") {
			source.onopen?.(new Event("open"));
			return;
		}
		const event =
			frame.data === undefined
				? new Event(frame.name)
				: new MessageEvent(frame.name, { data: frame.data, lastEventId: frame.lastEventId ?? "" });
		for (const handler of listeners.get(frame.name) ?? []) handler(event);
	};
	worker.port.onmessageerror = () => {
		for (const handler of listeners.get("error") ?? []) handler(new Event("error"));
	};
	worker.onerror = () => {
		for (const handler of listeners.get("error") ?? []) handler(new Event("error"));
	};
	worker.port.start();
	worker.port.postMessage({ action: "open", url, names });
	window.addEventListener("pagehide", source.close);
	return source;
}
