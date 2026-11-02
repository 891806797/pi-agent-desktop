import type { AgentStatus, SessionSummary } from "./messages";

export interface CatalogSession extends SessionSummary {
	revision: number;
	archivedAt: number | null;
	lifecycle: "normal" | "deleting" | "deleted";
	managementError?: string;
	status: AgentStatus;
	pendingPermissions: number;
	pendingQuestions: number;
	recovering: boolean;
	needsReview: boolean;
	noticeVersion: number;
	readVersion: number;
	noticeKind: "attention" | "completed" | "failed" | "notification" | null;
	sessionSeq?: number;
	sessionEpoch?: string;
}
export interface CatalogQuery {
	workspace?: string;
	q?: string;
	archived?: boolean;
	cursor?: string;
	limit?: number;
}
export interface CatalogSnapshot {
	sessions: CatalogSession[];
	nextCursor: string | null;
	attention: CatalogSession[];
	epoch: string;
	seq: number;
	listVersion: number;
	removed?: string[];
}
export type UserEvent =
	| { event: "session_updated"; data: CatalogSession }
	| { event: "session_removed"; data: { sessionId: string } };
export type SequencedUserEvent = UserEvent & { seq: number; epoch: string };
