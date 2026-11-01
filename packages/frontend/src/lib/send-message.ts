import type { RunMode, SendMessageInput } from "@pi-agent/common";
import * as api from "./api";

/** Keeps creation, preferences and the first send bound to the same captured session. */
export async function sendToSession(
	input: SendMessageInput,
	workspace: string,
	sessionId: string | null,
	mode: RunMode,
	callbacks: {
		isCurrent: () => boolean;
		onCreated: (coords: api.SessionCoordinates) => void;
		pendingModes: Map<string, RunMode>;
	},
	deps = { create: api.createSession, setMode: api.setRunMode, send: api.sendMessage },
) {
	if (!sessionId) {
		sessionId = (await deps.create(workspace)).sessionId;
		if (!callbacks.isCurrent()) return false;
		callbacks.pendingModes.set(sessionId, mode);
		callbacks.onCreated({ sessionId, workspace });
	}
	if (!callbacks.isCurrent()) return false;
	// A failed initial preference must succeed before retrying; ordinary sends keep live tab changes.
	const pendingMode = callbacks.pendingModes.get(sessionId);
	if (pendingMode) {
		await deps.setMode(pendingMode, { sessionId, workspace });
		callbacks.pendingModes.delete(sessionId);
	}
	if (!callbacks.isCurrent()) return false;
	const coords = { sessionId, workspace };
	await deps.send(input, coords);
	return callbacks.isCurrent();
}
