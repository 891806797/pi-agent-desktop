import { create } from "zustand";

export const THEMES = ["eye", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABELS: Record<Theme, string> = { eye: "护眼", light: "明亮", dark: "暗黑" };
const THEME_KEY = "pi-agent:theme";
export const parseTheme = (value: string | null): Theme =>
	THEMES.find((theme) => theme === value) ?? "eye";
export const nextTheme = (theme: Theme): Theme =>
	THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;

export const useThemeStore = create<{ theme: Theme; cycle: () => void }>((_set, get) => ({
	theme: "eye",
	cycle: () => applyTheme(nextTheme(get().theme), true),
}));

function applyTheme(theme: Theme, persist: boolean) {
	document.documentElement.dataset.theme = theme;
	document.documentElement.classList.toggle("dark", theme === "dark");
	useThemeStore.setState({ theme });
	if (persist) {
		try {
			localStorage.setItem(THEME_KEY, theme);
		} catch {
			/* 禁止本地存储时仍可切换当前页面。 */
		}
	}
}

/** 在 React 首次挂载前应用，所有页面与跨标签切换共享同一份主题状态。 */
export function initializeTheme() {
	let saved: string | null = null;
	try {
		saved = localStorage.getItem(THEME_KEY);
	} catch {
		/* 默认护眼色调。 */
	}
	applyTheme(parseTheme(saved), false);
	const sync = (event: StorageEvent) => {
		if (event.key === THEME_KEY || event.key === null)
			applyTheme(parseTheme(event.newValue), false);
	};
	window.addEventListener("storage", sync);
	return () => window.removeEventListener("storage", sync);
}
