import type { DefaultSettings, UpdateDefaultSettingsInput } from "@pi-agent/common";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import * as api from "./api";

let pending: Promise<void> = Promise.resolve();
let revision = 0;
let retry: (() => Promise<void>) | null = null;
function queue(
	action: (sameUser: () => boolean) => Promise<void>,
	user = useAuthStore.getState().username,
) {
	retry = null;
	const sameUser = () => useAuthStore.getState().username === user;
	const operation = pending
		.catch(() => {})
		.then(async () => {
			if (!sameUser()) return;
			try {
				await action(sameUser);
			} catch (error) {
				if (sameUser()) {
					if (pending === operation) retry = () => queue(action, user);
					throw error;
				}
			}
		});
	pending = operation;
	return operation;
}
function applyDraft(settings: DefaultSettings) {
	if (!api.urlSessionId())
		useChatStore.setState({
			model: settings.model,
			thinkingLevel: settings.thinkingLevel,
			runMode: settings.runMode,
		});
}

/** 序列化默认值与活会话修改；首条发送等待整个配置操作结束。 */
export function updatePreferences(
	patch: UpdateDefaultSettingsInput,
	isCurrent: () => boolean,
	applySession?: () => Promise<unknown>,
) {
	revision++;
	return queue(async (sameUser) => {
		const settings = await api.updateDefaultSettings(patch);
		if (!sameUser() || !isCurrent()) return;
		if (api.urlSessionId()) await applySession?.();
		else applyDraft(settings);
	});
}
export function loadPreferences(isCurrent: () => boolean) {
	const expected = revision;
	return queue(async (sameUser) => {
		if (!isCurrent()) return;
		const settings = await api.getDefaultSettings();
		if (sameUser() && isCurrent() && expected === revision) applyDraft(settings);
	});
}
export function applyInitialPreferences(action: () => Promise<void>): Promise<void> {
	return queue(async () => {
		await action();
	});
}
export function waitForPreferences(): Promise<void> {
	const waiting = pending;
	return waiting.then(
		() => {
			if (pending !== waiting) return waitForPreferences();
		},
		(error) => {
			if (pending !== waiting) return waitForPreferences();
			if (retry) return retry().then(() => waitForPreferences());
			throw error;
		},
	);
}
