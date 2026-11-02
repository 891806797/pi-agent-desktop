import { expect } from "bun:test";

Object.defineProperty(globalThis, "location", {
	configurable: true,
	value: { search: "?workspace=w", pathname: "/chat" },
});
const { useAuthStore } = await import("../../src/stores/auth");
const { useChatStore } = await import("../../src/stores/chat");
useAuthStore.getState().setUsername("one");
let requests = 0,
	fail = true;
globalThis.fetch = async () => {
	requests++;
	if (fail) throw new Error("temporarily unavailable");
	return Response.json({
		ok: true,
		data: {
			model: { provider: "fixture", modelId: "selected" },
			thinkingLevel: "high",
			runMode: "safe",
		},
	});
};
const { loadPreferences, updatePreferences, waitForPreferences } = await import(
	"../../src/lib/default-settings"
);
await expect(loadPreferences(() => true)).rejects.toThrow("temporarily unavailable");
fail = false;
await waitForPreferences();
expect(requests).toBe(2);
expect(useChatStore.getState().thinkingLevel).toBe("high");
location.search = "?workspace=w&sessionId=A";
let attempts = 0;
await expect(
	updatePreferences(
		{ thinkingLevel: "high" },
		() => true,
		async () => {
			if (++attempts === 1) throw new Error("update temporarily failed");
		},
	),
).rejects.toThrow("update temporarily failed");
await waitForPreferences();
expect(attempts).toBe(2);
fail = true;
await expect(loadPreferences(() => true)).rejects.toThrow();
const before = requests;
useAuthStore.getState().setUsername("two");
await waitForPreferences();
expect(requests).toBe(before);

// 发送等待期间继续选择配置，必须等最新操作也应用完成。
useAuthStore.getState().setUsername("one");
fail = false;
const gates: Array<() => void> = [];
globalThis.fetch = () =>
	new Promise((resolve) =>
		gates.push(() =>
			resolve(
				Response.json({ ok: true, data: { model: null, thinkingLevel: "off", runMode: "safe" } }),
			),
		),
	);
const first = updatePreferences({ runMode: "safe" }, () => true);
await new Promise((resolve) => setTimeout(resolve, 0));
let released = false;
const waiting = waitForPreferences().then(() => {
	released = true;
});
const second = updatePreferences({ thinkingLevel: "high" }, () => true);
gates.shift()!();
await new Promise((resolve) => setTimeout(resolve, 0));
expect(released).toBe(false);
gates.shift()!();
await Promise.all([first, second, waiting]);
expect(released).toBe(true);
