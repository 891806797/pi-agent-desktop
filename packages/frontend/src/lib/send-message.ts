import type { ModelRef, RunMode, SendMessageInput, ThinkingLevel } from "@pi-agent/common";
import * as api from "./api";

export interface InitialSessionSettings {
	runMode?: RunMode;
	model?: Pick<ModelRef, "provider" | "modelId">;
	thinkingLevel?: ThinkingLevel;
}
export type PendingSessionSettings = InitialSessionSettings & {
	prepare?: () => Promise<InitialSessionSettings>;
};

/** Keeps creation, preferences and the first send bound to the same captured session. */
export async function sendToSession(
	input: SendMessageInput,
	workspace: string,
	sessionId: string | null,
	settings: InitialSessionSettings,
	callbacks: {
		isCurrent: () => boolean;
		onCreated: (coords: api.SessionCoordinates) => void;
		pendingSettings: Map<string, PendingSessionSettings>;
		prepareSettings?: () => Promise<InitialSessionSettings>;
		applyInitial?: (action: () => Promise<void>) => Promise<void>;
		beforeSend?: () => Promise<void>;
	},
	deps = {
		create: api.createSession,
		setMode: api.setRunMode,
		setModel: api.setModel,
		setThinking: api.setThinking,
		send: api.sendMessage,
	},
) {
	if (!callbacks.isCurrent()) return false;
	if (!sessionId) {
		sessionId = (await deps.create(workspace)).sessionId;
		if (!callbacks.isCurrent()) return false;
		callbacks.pendingSettings.set(sessionId, { ...settings, prepare: callbacks.prepareSettings });
		callbacks.onCreated({ sessionId, workspace });
	}
	if (!callbacks.isCurrent()) return false;
	// A failed initial preference must succeed before retrying; ordinary sends keep live tab changes.
	const coords = { sessionId, workspace };
	const pending = callbacks.pendingSettings.get(sessionId);
	if (pending) {
		const apply = async () => {
			if (pending.prepare) Object.assign(pending, await pending.prepare());
			if (!callbacks.isCurrent()) return;
			if (pending.runMode !== undefined) {
				await deps.setMode(pending.runMode, coords);
				delete pending.runMode;
			}
			if (!callbacks.isCurrent()) return;
			if (pending.model) {
				await deps.setModel(pending.model.provider, pending.model.modelId, coords);
				delete pending.model;
			}
			if (!callbacks.isCurrent()) return;
			if (pending.thinkingLevel !== undefined) {
				await deps.setThinking(pending.thinkingLevel, coords);
				delete pending.thinkingLevel;
			}
			callbacks.pendingSettings.delete(sessionId);
		};
		if (callbacks.applyInitial) await callbacks.applyInitial(apply);
		else await apply();
	}
	await callbacks.beforeSend?.();
	if (!callbacks.isCurrent()) return false;
	await deps.send(input, coords);
	return callbacks.isCurrent();
}
