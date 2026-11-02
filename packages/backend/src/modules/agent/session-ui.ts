import { AsyncLocalStorage } from "node:async_hooks";
import { stripVTControlCharacters } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	type ExtensionUISnapshot,
	emptyExtensionUI,
	EXTENSION_UI_LIMITS as limits,
	type PendingKind,
	type PendingPayload,
	utf8Length,
} from "@pi-agent/common";
import { AppError } from "@/core/app-error";
import type { ApprovalManager, ApprovalOptions } from "./approval-manager";
import type { SessionEventBus } from "./event-bus";

/** 会话拥有展示数据，页面拥有草稿；不执行终端 Component factory。 */
export class SessionUI {
	private state = emptyExtensionUI();
	private timer?: ReturnType<typeof setTimeout>;
	private dirty = false;
	private disposed = false;
	private source = new AsyncLocalStorage<{ toolCallId: string; ordinal: number }>();
	private wrapped = new WeakSet<AgentSession["agent"]["state"]["tools"][number]["execute"]>();
	constructor(
		private bus: SessionEventBus,
		private approvals: ApprovalManager,
	) {}
	get snapshot(): ExtensionUISnapshot {
		return structuredClone(this.state);
	}
	withSource<T>(toolCallId: string, action: () => T): T {
		return this.source.run({ toolCallId, ordinal: 0 }, action);
	}
	bindTools(tools: AgentSession["agent"]["state"]["tools"]) {
		for (const tool of tools) {
			if (this.wrapped.has(tool.execute)) continue;
			const execute = tool.execute;
			tool.execute = (...args) => this.withSource(args[0], () => execute.apply(tool, args));
			this.wrapped.add(tool.execute);
		}
	}
	private key(key: string) {
		if (!key || key.length > limits.key || ["__proto__", "constructor", "prototype"].includes(key))
			throw new AppError("BAD_REQUEST", "扩展展示 key 长度不合法");
	}
	private changed() {
		if (this.disposed) return;
		this.dirty = true;
		this.timer ??= setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, 200);
	}
	flush() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.dirty && !this.disposed) {
			this.dirty = false;
			this.bus.publish({ event: "extension_ui", data: this.snapshot });
		}
	}
	setStatus(key: string, value?: string) {
		this.key(key);
		if (value === undefined) delete this.state.statuses[key];
		else {
			if (
				value.length > limits.status ||
				(!(key in this.state.statuses) &&
					Object.keys(this.state.statuses).length >= limits.statuses)
			)
				throw new AppError("BAD_REQUEST", "扩展状态超过展示限额");
			this.state.statuses[key] = stripVTControlCharacters(value);
		}
		this.changed();
	}
	setWidget(
		key: string,
		lines?: string[],
		placement: "aboveEditor" | "belowEditor" = "aboveEditor",
	) {
		this.key(key);
		const widgets = { ...this.state.widgets };
		if (lines === undefined) delete widgets[key];
		else widgets[key] = { lines: lines.map((line) => stripVTControlCharacters(line)), placement };
		const sizes = Object.values(widgets).map((widget) => utf8Length(widget.lines.join("\n")));
		if (
			Object.keys(widgets).length > limits.widgets ||
			sizes.some((size) => size > limits.widgetBytes) ||
			sizes.reduce((a, b) => a + b, 0) > limits.totalWidgetBytes
		)
			throw new AppError("BAD_REQUEST", "扩展文字块超过展示限额");
		this.state.widgets = widgets;
		this.changed();
	}
	setWorkingMessage(message?: string) {
		if (message && message.length > limits.status)
			throw new AppError("BAD_REQUEST", "运行提示过长");
		this.state.workingMessage =
			message === undefined ? undefined : stripVTControlCharacters(message);
		this.changed();
	}
	setWorkingVisible(visible: boolean) {
		this.state.workingVisible = visible;
		this.changed();
	}
	notify(message: string, type: "info" | "warning" | "error" = "info") {
		if (utf8Length(message) > limits.notificationBytes)
			throw new AppError("BAD_REQUEST", "扩展通知过长");
		if (!this.disposed)
			this.bus.publish({
				event: "extension_notify",
				data: { id: crypto.randomUUID(), message: stripVTControlCharacters(message), type },
			});
	}
	dialog(kind: PendingKind, payload: PendingPayload, options: ApprovalOptions = {}) {
		const source = this.source.getStore();
		const origin = source
			? { toolCallId: source.toolCallId, ordinal: source.ordinal++ }
			: undefined;
		const id = origin ? `ui:${origin.toolCallId}:${origin.ordinal}` : crypto.randomUUID();
		return this.approvals.create(kind, id, payload, { ...options, origin });
	}
	async editor(title: string, prefill?: string): Promise<string | undefined> {
		if (prefill && utf8Length(prefill) > limits.editorBytes)
			throw new AppError("BAD_REQUEST", "编辑内容超过128 KiB");
		const result = await this.dialog("ui_editor", { title, prefill });
		return typeof result === "string" ? result : undefined;
	}
	dispose() {
		this.flush();
		this.disposed = true;
	}
}
