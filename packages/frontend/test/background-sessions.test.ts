import { afterEach, expect, test } from "bun:test";
import type { CatalogSession, CatalogSnapshot } from "@pi-agent/common";
import { useSessionsStore } from "../src/stores/sessions";

afterEach(() => useSessionsStore.getState().reset());
const row: CatalogSession = {
	sessionId: "a",
	workspace: "D:/a",
	firstMessage: "hello",
	revision: 1,
	archivedAt: null,
	lifecycle: "normal",
	live: true,
	status: "awaiting-approval",
	pendingPermissions: 1,
	pendingQuestions: 0,
	needsReview: false,
	recovering: false,
	noticeVersion: 1,
	readVersion: 0,
	noticeKind: "attention",
};
test("background summary survives chat switches, remains pending when read and cannot be resurrected by a stale event", () => {
	const state = useSessionsStore.getState();
	state.load({
		sessions: [],
		attention: [row],
		seq: 2,
		epoch: "epoch",
		listVersion: 1,
		nextCursor: null,
	} satisfies CatalogSnapshot);
	expect(useSessionsStore.getState().rows.a?.pendingPermissions).toBe(1);
	state.apply({
		epoch: "epoch",
		seq: 3,
		event: "session_updated",
		data: { ...row, readVersion: 1 },
	});
	expect(useSessionsStore.getState().attention()).toHaveLength(1);
	state.apply({ epoch: "epoch", seq: 4, event: "session_removed", data: { sessionId: "a" } });
	state.apply({ epoch: "epoch", seq: 3, event: "session_updated", data: row });
	expect(useSessionsStore.getState().rows.a).toBeUndefined();
});

test("unchanged fallback snapshots do not reset pagination, and deletions survive a snapshot", () => {
	const snapshot = {
		sessions: [row],
		attention: [row],
		seq: 2,
		epoch: "epoch",
		listVersion: 1,
		nextCursor: null,
	};
	useSessionsStore.getState().load(snapshot);
	const changes = useSessionsStore.getState().changes;
	useSessionsStore.getState().load(snapshot);
	expect(useSessionsStore.getState().changes).toBe(changes);
	useSessionsStore
		.getState()
		.load({ ...snapshot, sessions: [], attention: [], listVersion: 2, removed: [row.sessionId] });
	expect(useSessionsStore.getState().removed[row.sessionId]).toBe(true);
});
