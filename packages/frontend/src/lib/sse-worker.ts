interface Frame {
	name: string;
	data?: string;
	lastEventId?: string;
}
interface Pool {
	stream: EventSource;
	ports: Set<MessagePort>;
	frames: Frame[];
	seq: number;
	names: Set<string>;
}
const pools = new Map<string, Pool>();
const scope = globalThis as unknown as { onconnect: (event: { ports: MessagePort[] }) => void };
scope.onconnect = (event) => {
	const port = event.ports[0]!;
	let key: string | undefined;
	const close = () => {
		if (!key) return;
		const pool = pools.get(key);
		pool?.ports.delete(port);
		if (pool && !pool.ports.size) {
			pool.stream.close();
			pools.delete(key);
		}
		key = undefined;
	};
	port.onmessage = (message) => {
		const request = message.data as { action: "open" | "close"; url: string; names: string[] };
		close();
		if (request.action === "close") return;
		const url = new URL(request.url, location.origin);
		const since = Number(url.searchParams.get("sinceSeq")) || 0;
		const canonical = new URL(url);
		canonical.searchParams.delete("sinceSeq");
		canonical.searchParams.sort();
		key = canonical.toString();
		let pool = pools.get(key);
		if (!pool) {
			const stream = new EventSource(url);
			pool = { stream, ports: new Set(), frames: [], seq: since, names: new Set() };
			pools.set(key, pool);
			const current = pool;
			stream.onopen = () => {
				for (const target of current.ports) target.postMessage({ name: "open" });
			};
		}
		for (const name of request.names) {
			if (pool.names.has(name)) continue;
			pool.names.add(name);
			const current = pool;
			pool.stream.addEventListener(name, (event) => {
				const frame = event as MessageEvent;
				const value: Frame = { name, data: frame.data, lastEventId: frame.lastEventId };
				const seq = Number(frame.lastEventId) || 0;
				if (seq > 0 && name !== "heartbeat") {
					current.seq = seq;
					current.frames.push(value);
					if (current.frames.length > 500) current.frames.shift();
				}
				for (const target of current.ports) target.postMessage(value);
			});
		}
		const frames = pool.frames.filter((frame) => Number(frame.lastEventId) > since);
		if (
			(pool.seq > since && (!frames.length || Number(frames[0]!.lastEventId) !== since + 1)) ||
			since > pool.seq
		) {
			port.postMessage(
				url.pathname === "/api/user/events"
					? { name: "resync", data: "{}" }
					: { name: "error", data: JSON.stringify({ message: "__resync__" }) },
			);
			key = undefined;
			return;
		}
		pool.ports.add(port);
		for (const frame of frames) port.postMessage(frame);
		if (pool.stream.readyState === EventSource.OPEN) port.postMessage({ name: "open" });
	};
	port.onmessageerror = close;
	port.start();
};
