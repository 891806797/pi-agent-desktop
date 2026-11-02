/**
 * 当前白名单扩展使用的 Web 对话框桥接，统一走 ApprovalManager 的生命周期。
 * 声明式状态和文字展示由 SessionUI 管理，磁盘扩展保持禁用。
 * custom 等依赖终端组件工厂的 API 不能直接迁入浏览器。
 */

import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { ApprovalManager } from "./approval-manager";
import type { SessionUI } from "./session-ui";

export function makeWebUIContext(
	approvals: ApprovalManager,
	display?: SessionUI,
): ExtensionUIContext {
	const dialog = (
		kind: Parameters<ApprovalManager["create"]>[0],
		payload: Parameters<ApprovalManager["create"]>[2],
		opts?: ExtensionUIDialogOptions,
	) =>
		display
			? display.dialog(kind, payload, opts)
			: approvals.create(kind, crypto.randomUUID(), payload, opts);
	const ui = {
		select: async (title: string, options: string[], opts?: ExtensionUIDialogOptions) => {
			const r = await dialog("ui_select", { title, options }, opts);
			return typeof r === "string" ? r : undefined;
		},
		confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions) => {
			const r = await dialog("ui_confirm", { title, message }, opts);
			return r === true;
		},
		input: async (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => {
			const r = await dialog("ui_input", { title, placeholder }, opts);
			return typeof r === "string" ? r : undefined;
		},
		editor: (title: string, prefill?: string) =>
			display?.editor(title, prefill) ?? Promise.resolve(undefined),
		custom: async () => undefined as never,
		notify: (message: string, type?: "info" | "warning" | "error") =>
			display?.notify(message, type),
		onTerminalInput: () => () => {},
		setStatus: (key: string, text?: string) => display?.setStatus(key, text),
		setWorkingMessage: (message?: string) => display?.setWorkingMessage(message),
		setWorkingVisible: (visible: boolean) => display?.setWorkingVisible(visible),
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: (
			key: string,
			content: unknown,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		) => {
			if (
				content !== undefined &&
				(!Array.isArray(content) || !content.every((line) => typeof line === "string"))
			)
				throw new Error("Web 只支持文字 widget，不支持终端组件 factory");
			display?.setWidget(key, content as string[] | undefined, options?.placement);
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	// biome-ignore lint/suspicious/noExplicitAny: theme 依赖 pi 内部 TUI Theme 类型，Web 宿主不可用，置 undefined 桥接
	const withTheme = { ...ui, theme: undefined } as { theme?: any };
	// biome-ignore lint/suspicious/noExplicitAny: 同上：结构不完整处（TUI 专属字段）以桥接类型放行
	return withTheme as any as ExtensionUIContext;
}
