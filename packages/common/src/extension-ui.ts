export const EXTENSION_UI_LIMITS = {
	key: 64,
	statuses: 32,
	status: 512,
	widgets: 16,
	widgetBytes: 16 * 1024,
	totalWidgetBytes: 64 * 1024,
	notificationBytes: 4 * 1024,
	editorBytes: 128 * 1024,
} as const;
export interface ExtensionUISnapshot {
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	workingMessage?: string;
	workingVisible: boolean;
}
export const emptyExtensionUI = (): ExtensionUISnapshot => ({
	statuses: {},
	widgets: {},
	workingVisible: true,
});
export const utf8Length = (text: string) => new TextEncoder().encode(text).length;
