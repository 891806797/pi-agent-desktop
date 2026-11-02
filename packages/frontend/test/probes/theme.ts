import { expect } from "bun:test";
import { initializeTheme, useThemeStore } from "../../src/lib/theme";

let value: string | null = "dark";
let listener: ((event: { key: string | null; newValue: string | null }) => void) | undefined;
const classes = new Set<string>();
const root = {
	dataset: {} as Record<string, string>,
	classList: {
		toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name)),
	},
};
Object.defineProperty(globalThis, "document", {
	value: { documentElement: root },
	configurable: true,
});
Object.defineProperty(globalThis, "window", {
	value: {
		addEventListener: (_name: string, callback: typeof listener) => {
			listener = callback;
		},
		removeEventListener: () => {
			listener = undefined;
		},
	},
	configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: () => value,
		setItem: (_key: string, next: string) => {
			value = next;
		},
	},
	configurable: true,
});
const dispose = initializeTheme();
expect(root.dataset.theme).toBe("dark");
expect(classes.has("dark")).toBe(true);
useThemeStore.getState().cycle();
expect(value).toBe("eye");
expect(classes.has("dark")).toBe(false);
useThemeStore.getState().cycle();
expect(root.dataset.theme).toBe("light");
listener?.({ key: "pi-agent:theme", newValue: "dark" });
expect(useThemeStore.getState().theme).toBe("dark");
listener?.({ key: "unrelated", newValue: "eye" });
expect(useThemeStore.getState().theme).toBe("dark");
listener?.({ key: null, newValue: null });
expect(useThemeStore.getState().theme).toBe("eye");
dispose();
expect(listener).toBeUndefined();
Object.defineProperty(globalThis, "localStorage", {
	get: () => {
		throw new Error("disabled");
	},
	configurable: true,
});
const cleanup = initializeTheme();
useThemeStore.getState().cycle();
expect(useThemeStore.getState().theme).toBe("light");
cleanup();
