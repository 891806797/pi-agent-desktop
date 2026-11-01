import { expect, test } from "bun:test";
import type { SessionCoordinates } from "../src/lib/api";
import { sendToSession } from "../src/lib/send-message";

for (const failure of ["mode", "send"] as const)
	test(`created coordinates survive ${failure} failure and retry uses same session`, async () => {
		let saved: SessionCoordinates | null = null;
		let creates = 0;
		let fail = true;
		const order: string[] = [];
		let effectiveMode = "standard";
		const deps = {
			create: async () => {
				creates++;
				return { sessionId: "created", live: true };
			},
			setMode: async () => {
				order.push("mode");
				if (fail && failure === "mode") throw Error("mode failed");
				effectiveMode = "safe";
			},
			send: async () => {
				order.push("send");
				expect(effectiveMode).toBe("safe");
				if (fail && failure === "send") throw Error("response lost after accepted");
				return { queued: false };
			},
		};
		const callbacks = {
			isCurrent: () => true,
			pendingModes: new Map(),
			onCreated: (coords: SessionCoordinates) => {
				saved = coords;
				order.push("attached");
			},
		};
		await expect(
			sendToSession({ text: "first" }, "w", null, "safe", callbacks, deps),
		).rejects.toThrow();
		expect(saved).toEqual({ sessionId: "created", workspace: "w" });
		expect(order[0]).toBe("attached");
		fail = false;
		order.length = 0;
		await sendToSession({ text: "retry" }, "w", saved?.sessionId ?? null, "safe", callbacks, deps);
		expect(creates).toBe(1);
		if (failure === "mode") expect(order).toEqual(["mode", "send"]);
	});
test("creation response from a departed page cannot attach or send", async () => {
	let resolve!: (value: { sessionId: string; live: boolean }) => void;
	let current = true;
	let attached = false;
	let sent = false;
	const p = sendToSession(
		{ text: "first" },
		"w",
		null,
		"safe",
		{
			isCurrent: () => current,
			pendingModes: new Map(),
			onCreated: () => {
				attached = true;
			},
		},
		{
			create: () =>
				new Promise((r) => {
					resolve = r;
				}),
			setMode: async () => {},
			send: async () => {
				sent = true;
				return { queued: false };
			},
		},
	);
	current = false;
	resolve({ sessionId: "stale", live: true });
	await p;
	expect(attached).toBe(false);
	expect(sent).toBe(false);
});
