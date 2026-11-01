/**
 * 当前白名单扩展使用的 Web 对话框桥接，统一走 ApprovalManager 的生命周期。
 * 此处不是完整的扩展 UI 宿主：展示型 API 尚未接入，磁盘扩展保持禁用。
 * custom 等依赖终端组件工厂的 API 不能直接迁入浏览器。
 */

import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { ApprovalManager } from "./approval-manager";

export function makeWebUIContext(approvals: ApprovalManager): ExtensionUIContext {
	const ui = {
		select: async (title: string, options: string[], opts?: ExtensionUIDialogOptions) => {
			const r = await approvals.create("ui_select", crypto.randomUUID(), { title, options }, opts);
			return typeof r === "string" ? r : undefined;
		},
		confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions) => {
			const r = await approvals.create("ui_confirm", crypto.randomUUID(), { title, message }, opts);
			return r === true;
		},
		input: async (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => {
			const r = await approvals.create(
				"ui_input",
				crypto.randomUUID(),
				{ title, placeholder },
				opts,
			);
			return typeof r === "string" ? r : undefined;
		},
		editor: async () => undefined,
		custom: async () => undefined as never,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
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
