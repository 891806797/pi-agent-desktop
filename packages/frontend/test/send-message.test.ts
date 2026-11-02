import { expect, test } from "bun:test";
import type { SessionCoordinates } from "../src/lib/api";
import { sendToSession } from "../src/lib/send-message";

test("a send that became stale while waiting for preferences never creates a session", async () => {
	let creates = 0;
	const result = await sendToSession(
		{ text: "stale" },
		"w",
		null,
		{},
		{ isCurrent: () => false, onCreated: () => {}, pendingSettings: new Map() },
		{
			create: async () => {
				creates++;
				return { sessionId: "orphan", live: true };
			},
			setMode: async () => {},
			setModel: async () => {},
			setThinking: async () => {},
			send: async () => ({ queued: false }),
		},
	);
	expect(result).toBe(false);
	expect(creates).toBe(0);
});

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
			setModel: async () => {},
			setThinking: async () => {},
			send: async () => {
				order.push("send");
				expect(effectiveMode).toBe("safe");
				if (fail && failure === "send") throw Error("response lost after accepted");
				return { queued: false };
			},
		};
		const callbacks = {
			isCurrent: () => true,
			pendingSettings: new Map(),
			onCreated: (coords: SessionCoordinates) => {
				saved = coords;
				order.push("attached");
			},
		};
		await expect(
			sendToSession({ text: "first" }, "w", null, { runMode: "safe" }, callbacks, deps),
		).rejects.toThrow();
		expect(saved).toEqual({ sessionId: "created", workspace: "w" });
		expect(order[0]).toBe("attached");
		fail = false;
		order.length = 0;
		await sendToSession(
			{ text: "retry" },
			"w",
			saved?.sessionId ?? null,
			{ runMode: "safe" },
			callbacks,
			deps,
		);
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
		{ runMode: "safe" },
		{
			isCurrent: () => current,
			pendingSettings: new Map(),
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
			setModel: async () => {},
			setThinking: async () => {},
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

test("new-session model and thinking are applied before sending; retries retain the captured settings", async () => {
	const order: string[] = [];
	let failThinking = true;
	let saved: SessionCoordinates | null = null;
	const callbacks = {
		isCurrent: () => true,
		onCreated: (coords: SessionCoordinates) => {
			saved = coords;
		},
		pendingSettings: new Map(),
	};
	const deps = {
		create: async () => ({ sessionId: "created", live: true }),
		setMode: async () => {
			order.push("mode");
		},
		setModel: async (provider: string, modelId: string, coords: SessionCoordinates) => {
			expect(coords.sessionId).toBe("created");
			order.push(`${provider}/${modelId}`);
		},
		setThinking: async (level: string, coords: SessionCoordinates) => {
			expect(coords.workspace).toBe("w");
			order.push(level);
			if (failThinking) throw new Error("thinking failed");
		},
		send: async () => {
			order.push("send");
			return { queued: false };
		},
	};
	const settings = {
		runMode: "safe" as const,
		model: { provider: "fixture", modelId: "draft" },
		thinkingLevel: "high" as const,
	};
	await expect(
		sendToSession({ text: "first" }, "w", null, settings, callbacks, deps),
	).rejects.toThrow("thinking failed");
	expect(order).toEqual(["mode", "fixture/draft", "high"]);
	failThinking = false;
	order.length = 0;
	await sendToSession(
		{ text: "retry" },
		"w",
		saved!.sessionId,
		{ runMode: "standard" },
		callbacks,
		deps,
	);
	expect(order).toEqual(["high", "send"]);
});

test("a model chosen while session creation is pending replaces the original draft snapshot", async () => {
	let release!: (value: { sessionId: string; live: boolean }) => void;
	let selected = "a";
	let applied = "";
	const operation = sendToSession(
		{ text: "first" },
		"w",
		null,
		{ model: { provider: "fixture", modelId: "a" } },
		{
			isCurrent: () => true,
			onCreated: () => {},
			pendingSettings: new Map(),
			prepareSettings: async () => ({ model: { provider: "fixture", modelId: selected } }),
		},
		{
			create: () =>
				new Promise((resolve) => {
					release = resolve;
				}),
			setMode: async () => {},
			setModel: async (_provider, modelId) => {
				applied = modelId;
			},
			setThinking: async () => {},
			send: async () => {
				expect(applied).toBe("b");
				return { queued: false };
			},
		},
	);
	selected = "b";
	release({ sessionId: "created", live: true });
	await operation;
});
