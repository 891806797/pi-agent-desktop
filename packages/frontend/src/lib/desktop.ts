import type { DesktopHttpResponse, DesktopStreamFrame } from "@pi-agent/common";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { EventSourceTransport } from "./shared-event-source";

export const isDesktop = () => typeof window !== "undefined" && isTauri();

let desktopVisible = false;
let navigationPending = false;
/** WebView2 隐藏窗口后仍可能声称 DOM 可见，以原生宿主为准。 */
export const isPageVisible = () =>
	document.visibilityState === "visible" &&
	(!isDesktop() || (desktopVisible && !navigationPending));
export function setDesktopNavigationPending(pending: boolean) {
	if (navigationPending === pending) return;
	navigationPending = pending;
	window.dispatchEvent(new Event("desktop:visibilitychange"));
}
export function setDesktopVisibility(visible: boolean) {
	if (desktopVisible === visible) return;
	desktopVisible = visible;
	window.dispatchEvent(new Event("desktop:visibilitychange"));
}

export async function desktopFetch(path: string, init: RequestInit = {}): Promise<Response> {
	if (init.body != null && typeof init.body !== "string")
		throw new TypeError("桌面 API 请求体必须为 JSON 文本");
	const response = await invoke<DesktopHttpResponse>("backend_request", {
		request: {
			path,
			method: init.method ?? "GET",
			...(init.headers ? { headers: Object.fromEntries(new Headers(init.headers)) } : {}),
			...(init.body != null ? { body: init.body } : {}),
		},
	});
	return new Response(response.body, { status: response.status });
}

export function openDesktopEventSource(path: string): EventSourceTransport {
	const id = crypto.randomUUID();
	const listeners = new Map<string, Set<(event: Event) => void>>();
	let closed = false;
	const deliver = (frame: DesktopStreamFrame) => {
		if (closed) return;
		if (frame.name === "open") {
			source.onopen?.(new Event("open"));
			return;
		}
		const event =
			frame.data == null
				? new Event(frame.name)
				: new MessageEvent(frame.name, { data: frame.data, lastEventId: frame.lastEventId ?? "" });
		for (const listener of listeners.get(frame.name) ?? []) listener(event);
	};
	const unsubscribe = () => invoke("backend_unsubscribe", { id }).catch(() => undefined);
	const source: EventSourceTransport = {
		onopen: null,
		addEventListener(name, listener) {
			let handlers = listeners.get(name);
			if (!handlers) {
				handlers = new Set();
				listeners.set(name, handlers);
			}
			handlers.add(listener);
		},
		close() {
			if (closed) return;
			closed = true;
			listeners.clear();
			window.removeEventListener("pagehide", source.close);
			void unsubscribe();
		},
	};
	const onEvent = new Channel<DesktopStreamFrame>(deliver);
	window.addEventListener("pagehide", source.close);
	void invoke("backend_subscribe", { id, path, onEvent })
		.then(() => {
			// close 可能发生在 Rust 完成注册前；ack 后再次取消，避免遗留订阅。
			if (closed) void unsubscribe();
		})
		.catch(() => deliver({ name: "error" }));
	return source;
}
