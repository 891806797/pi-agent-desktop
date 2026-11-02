import type { CatalogSession, CatalogSnapshot, SequencedUserEvent } from "@pi-agent/common";
import { create } from "zustand";

export const needsAttention = (row: CatalogSession) =>
	row.lifecycle !== "deleted" &&
	(row.lifecycle === "deleting" ||
		row.pendingPermissions > 0 ||
		row.pendingQuestions > 0 ||
		row.needsReview ||
		row.status === "error" ||
		row.noticeVersion > row.readVersion);
interface SessionsState {
	rows: Record<string, CatalogSession>;
	epoch: string;
	seq: number;
	changes: number;
	listVersion: number;
	error: string | null;
	removed: Record<string, true>;
	load: (snapshot: CatalogSnapshot) => void;
	apply: (event: SequencedUserEvent) => void;
	attention: () => CatalogSession[];
	reset: () => void;
}
const initial = {
	rows: {},
	removed: {},
	epoch: "",
	seq: 0,
	changes: 0,
	listVersion: -1,
	error: null,
};
export const useSessionsStore = create<SessionsState>((set, get) => ({
	...initial,
	load: (snapshot) =>
		set((state) => ({
			rows: Object.fromEntries(
				[...snapshot.sessions, ...snapshot.attention].map((row) => [row.sessionId, row]),
			),
			epoch: snapshot.epoch,
			seq: snapshot.seq,
			changes:
				state.changes +
				Number(state.epoch !== snapshot.epoch || state.listVersion !== snapshot.listVersion),
			listVersion: snapshot.listVersion,
			removed: Object.fromEntries((snapshot.removed ?? []).map((id) => [id, true as const])),
			error: null,
		})),
	apply: (event) =>
		set((state) => {
			if (state.epoch !== event.epoch || event.seq <= state.seq) return state;
			if (event.event === "session_removed") {
				const rows = { ...state.rows };
				delete rows[event.data.sessionId];
				return {
					rows,
					seq: event.seq,
					changes: state.changes + 1,
					removed: { ...state.removed, [event.data.sessionId]: true },
				};
			}
			const row = event.data;
			const old = state.rows[row.sessionId];
			const changed =
				!old ||
				old.name !== row.name ||
				old.archivedAt !== row.archivedAt ||
				old.lastActiveAt !== row.lastActiveAt;
			return {
				rows: { ...state.rows, [row.sessionId]: row },
				seq: event.seq,
				changes: state.changes + Number(changed),
			};
		}),
	attention: () => Object.values(get().rows).filter(needsAttention),
	reset: () => set({ ...initial, rows: {}, removed: {} }),
}));
