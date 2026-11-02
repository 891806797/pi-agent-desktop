import { relative } from "node:path";
import type {
	CatalogQuery,
	CatalogSession,
	CatalogSnapshot,
	SessionSummary,
} from "@pi-agent/common";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@/core/app-error";
import { openRuntimeDatabase } from "@/db";
import { sessionCatalog as table, userCatalogState } from "@/db/schema";
import { contentText } from "./event-translator";
import type { SessionContext } from "./session-registry";
import { UserEventHub } from "./user-events";

type Projection = Pick<
	CatalogSession,
	| "status"
	| "live"
	| "pendingPermissions"
	| "pendingQuestions"
	| "recovering"
	| "needsReview"
	| "sessionSeq"
	| "sessionEpoch"
>;
const cursorSchema = z.object({
	userId: z.string(),
	filter: z.string(),
	version: z.number(),
	offset: z.int().min(0),
});

export class SessionCatalog {
	private db: ReturnType<typeof openRuntimeDatabase>;
	private hubs = new Map<string, UserEventHub>();
	private projections = new Map<string, Projection>();
	constructor(file: string) {
		this.db = openRuntimeDatabase(file);
	}
	hub(userId: string) {
		let hub = this.hubs.get(userId);
		if (!hub) {
			hub = new UserEventHub();
			this.hubs.set(userId, hub);
		}
		return hub;
	}
	private key(userId: string, sessionId: string) {
		return JSON.stringify([userId, sessionId]);
	}
	private where(userId: string, sessionId: string) {
		return and(eq(table.userId, userId), eq(table.sessionId, sessionId));
	}
	private version(userId: string) {
		return (
			this.db.select().from(userCatalogState).where(eq(userCatalogState.userId, userId)).get()
				?.listVersion ?? 0
		);
	}
	private bump(userId: string) {
		this.db
			.insert(userCatalogState)
			.values({ userId, listVersion: 1 })
			.onConflictDoUpdate({
				target: userCatalogState.userId,
				set: { listVersion: sql`${userCatalogState.listVersion} + 1` },
			})
			.run();
	}
	get(userId: string, sessionId: string): CatalogSession | undefined {
		const row = this.db.select().from(table).where(this.where(userId, sessionId)).get();
		if (!row) return;
		return this.view(row);
	}
	private view(row: typeof table.$inferSelect): CatalogSession {
		return {
			sessionId: row.sessionId,
			workspace: row.workspace,
			firstMessage: row.firstMessage,
			name: row.name ?? undefined,
			createdAt: row.createdAt,
			lastActiveAt: row.updatedAt,
			revision: row.revision,
			archivedAt: row.archivedAt,
			lifecycle: row.lifecycle,
			managementError: row.managementError ?? undefined,
			noticeVersion: row.noticeVersion,
			readVersion: row.readVersion,
			noticeKind: row.noticeKind,
			live: false,
			status: row.noticeKind === "failed" && row.noticeVersion > row.readVersion ? "error" : "idle",
			pendingPermissions: 0,
			pendingQuestions: 0,
			recovering: false,
			needsReview: false,
			...this.projections.get(this.key(row.userId, row.sessionId)),
		};
	}
	assertAvailable(userId: string, sessionId: string) {
		const row = this.get(userId, sessionId);
		if (row && row.lifecycle !== "normal") throw new AppError("SESSION_DELETED");
	}
	require(userId: string, sessionId: string) {
		const row = this.get(userId, sessionId);
		if (!row) throw new AppError("NOT_FOUND");
		return row;
	}
	canRestoreEmpty(userId: string, sessionId: string, cwd: string): boolean {
		const row = this.db.select().from(table).where(this.where(userId, sessionId)).get();
		return (
			!!row && row.lifecycle === "normal" && !row.hasHistory && relative(row.workspace, cwd) === ""
		);
	}
	markHistory(userId: string, sessionId: string): void {
		this.db.update(table).set({ hasHistory: true }).where(this.where(userId, sessionId)).run();
	}
	upsert(userId: string, summary: Omit<SessionSummary, "live">, touch = false) {
		const old = this.get(userId, summary.sessionId);
		if (old && old.lifecycle !== "normal") return;
		const name = summary.name ?? old?.name;
		const firstMessage = summary.firstMessage || old?.firstMessage || "";
		if (old && !touch && old.name === name && old.firstMessage === firstMessage) return;
		const createdAt = old?.createdAt ?? summary.createdAt ?? new Date().toISOString();
		const updatedAt = touch
			? new Date().toISOString()
			: (summary.lastActiveAt ?? old?.lastActiveAt ?? createdAt);
		this.db.transaction(() => {
			this.db
				.insert(table)
				.values({
					userId,
					sessionId: summary.sessionId,
					workspace: summary.workspace,
					name,
					firstMessage,
					createdAt,
					updatedAt,
				})
				.onConflictDoUpdate({
					target: [table.userId, table.sessionId],
					set: {
						name: name ?? null,
						firstMessage,
						updatedAt,
						revision: sql`${table.revision} + 1`,
					},
				})
				.run();
			this.bump(userId);
		});
		this.publish(userId, summary.sessionId);
	}
	update(
		userId: string,
		sessionId: string,
		revision: number,
		patch: { name?: string; archived?: boolean },
	) {
		this.assertAvailable(userId, sessionId);
		this.db.transaction(() => {
			const row = this.require(userId, sessionId);
			if (row.revision !== revision) throw new AppError("SESSION_BUSY", "会话已更新，请刷新后重试");
			this.db
				.update(table)
				.set({
					...(patch.name !== undefined ? { name: patch.name } : {}),
					...(patch.archived !== undefined
						? { archivedAt: patch.archived ? Date.now() : null }
						: {}),
					revision: row.revision + 1,
				})
				.where(this.where(userId, sessionId))
				.run();
			this.bump(userId);
		});
		this.publish(userId, sessionId);
		return this.require(userId, sessionId);
	}
	project(userId: string, sessionId: string, patch: Partial<Projection>) {
		const row = this.get(userId, sessionId);
		if (row?.lifecycle !== "normal") return;
		const key = this.key(userId, sessionId);
		const next = {
			status: row.status,
			live: row.live,
			pendingPermissions: row.pendingPermissions,
			pendingQuestions: row.pendingQuestions,
			recovering: row.recovering,
			needsReview: row.needsReview,
			sessionSeq: row.sessionSeq,
			sessionEpoch: row.sessionEpoch,
			...patch,
		};
		if (JSON.stringify(this.projections.get(key)) === JSON.stringify(next)) return;
		this.projections.set(key, next);
		this.publish(userId, sessionId);
	}
	notify(userId: string, sessionId: string, kind: NonNullable<CatalogSession["noticeKind"]>) {
		this.assertAvailable(userId, sessionId);
		this.db
			.update(table)
			.set({ noticeVersion: sql`${table.noticeVersion} + 1`, noticeKind: kind })
			.where(this.where(userId, sessionId))
			.run();
		this.publish(userId, sessionId);
		return this.require(userId, sessionId);
	}
	markRead(userId: string, sessionId: string, version: number) {
		const row = this.require(userId, sessionId);
		this.db
			.update(table)
			.set({ readVersion: Math.max(row.readVersion, Math.min(version, row.noticeVersion)) })
			.where(this.where(userId, sessionId))
			.run();
		this.publish(userId, sessionId);
	}
	beginDelete(userId: string, sessionId: string, revision: number) {
		const row = this.require(userId, sessionId);
		if (row.lifecycle !== "normal") return;
		if (row.revision !== revision) throw new AppError("SESSION_BUSY", "会话已更新，请刷新后重试");
		this.db.transaction(() => {
			this.db
				.update(table)
				.set({ lifecycle: "deleting", revision: row.revision + 1 })
				.where(this.where(userId, sessionId))
				.run();
			this.bump(userId);
		});
		this.publish(userId, sessionId);
	}
	failDelete(userId: string, sessionId: string, error: string) {
		this.db
			.update(table)
			.set({ managementError: error })
			.where(this.where(userId, sessionId))
			.run();
		this.publish(userId, sessionId);
	}
	finishDelete(userId: string, sessionId: string) {
		if (this.require(userId, sessionId).lifecycle !== "deleting") return;
		this.db.transaction(() => {
			this.db
				.update(table)
				.set({
					lifecycle: "deleted",
					managementError: null,
					name: null,
					firstMessage: "",
					noticeVersion: 0,
					readVersion: 0,
					noticeKind: null,
				})
				.where(this.where(userId, sessionId))
				.run();
			this.bump(userId);
		});
		this.projections.delete(this.key(userId, sessionId));
		this.hub(userId).publish({ event: "session_removed", data: { sessionId } });
	}
	deleting(userId: string) {
		return this.db
			.select({ sessionId: table.sessionId })
			.from(table)
			.where(and(eq(table.userId, userId), eq(table.lifecycle, "deleting")))
			.all();
	}
	private publish(userId: string, sessionId: string) {
		this.hub(userId).publish({ event: "session_updated", data: this.require(userId, sessionId) });
	}
	list(userId: string, query: CatalogQuery = {}): CatalogSnapshot {
		const version = this.version(userId);
		const filter = JSON.stringify([query.workspace ?? "", query.q ?? "", !!query.archived]);
		let offset = 0;
		if (query.cursor) {
			try {
				const cursor = cursorSchema.parse(
					JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
				);
				if (cursor.userId !== userId || cursor.filter !== filter || cursor.version !== version)
					throw new Error();
				offset = cursor.offset;
			} catch {
				throw new AppError("CURSOR_EXPIRED");
			}
		}
		const all = this.db
			.select()
			.from(table)
			.where(and(eq(table.userId, userId), ne(table.lifecycle, "deleted")))
			.all()
			.map((row) => this.view(row));
		const rows = all
			.filter(
				(row) =>
					(!query.workspace || relative(row.workspace, query.workspace) === "") &&
					!!row.archivedAt === !!query.archived &&
					(!query.q ||
						`${row.name ?? ""}\n${row.firstMessage}`
							.toLocaleLowerCase()
							.includes(query.q.toLocaleLowerCase())),
			)
			.sort(
				(a, b) =>
					(b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") ||
					b.sessionId.localeCompare(a.sessionId),
			);
		const limit = Math.max(1, Math.min(100, query.limit ?? 30));
		const sessions = rows.slice(offset, offset + limit);
		const nextCursor =
			offset + limit < rows.length
				? Buffer.from(JSON.stringify({ userId, filter, version, offset: offset + limit })).toString(
						"base64url",
					)
				: null;
		return {
			sessions,
			nextCursor,
			attention: all.filter(
				(row) =>
					row.live ||
					row.lifecycle === "deleting" ||
					row.pendingPermissions ||
					row.pendingQuestions ||
					row.needsReview ||
					row.noticeVersion > row.readVersion,
			),
			listVersion: version,
			removed: this.db
				.select({ sessionId: table.sessionId })
				.from(table)
				.where(and(eq(table.userId, userId), eq(table.lifecycle, "deleted")))
				.all()
				.map((row) => row.sessionId),
			...this.hub(userId).cursor,
		};
	}
	close() {
		this.db.$client.close(true);
	}
	watch(ctx: SessionContext): void {
		const project = () => {
			const pending = ctx.approvals.pendingList();
			this.project(ctx.userId, ctx.sessionId, {
				live: true,
				status: ctx.recovery?.issue ? "error" : ctx.status,
				pendingPermissions: pending.filter((item) => item.kind === "tool_permission").length,
				pendingQuestions: pending.filter((item) => item.kind !== "tool_permission").length,
				needsReview: !!ctx.recovery?.blocked,
				recovering: !!ctx.recovery?.running && !ctx.recovery.issue && !pending.length,
				sessionSeq: ctx.bus.currentSeq,
				sessionEpoch: ctx.bus.epoch,
			});
		};
		ctx.bus.subscribe((event) => {
			if (
				ctx.closing ||
				![
					"status",
					"approval_request",
					"approval_settled",
					"run_issue",
					"extension_notify",
				].includes(event.event)
			)
				return;
			project();
			if (event.event === "approval_request") this.notify(ctx.userId, ctx.sessionId, "attention");
			if (event.event === "run_issue" && event.data.issue?.kind === "recovery")
				this.notify(ctx.userId, ctx.sessionId, "failed");
			if (event.event === "extension_notify" && event.data.type !== "info")
				this.notify(ctx.userId, ctx.sessionId, "notification");
		});
		ctx.session.subscribe((event) => {
			if (event.type === "agent_start") ctx.interrupted = false;
			if (event.type === "message_start" && event.message.role === "user")
				this.markHistory(ctx.userId, ctx.sessionId);
			if (!["message_end", "agent_settled", "entry_appended"].includes(event.type)) return;
			queueMicrotask(() => {
				if (ctx.closing) return;
				try {
					const first = ctx.session.messages.find((message) => message.role === "user");
					this.upsert(
						ctx.userId,
						{
							sessionId: ctx.sessionId,
							workspace: ctx.cwd,
							firstMessage: contentText(first?.content).slice(0, 100),
							name: ctx.session.sessionManager.getSessionName(),
						},
						event.type === "agent_settled",
					);
					project();
					if (event.type === "agent_settled" && !ctx.interrupted) {
						const last = ctx.session.messages.findLast((message) => message.role === "assistant");
						if (last?.role === "assistant" && last.stopReason !== "aborted")
							this.notify(
								ctx.userId,
								ctx.sessionId,
								last.stopReason === "error" ? "failed" : "completed",
							);
					}
				} catch (error) {
					ctx.bus.publish({
						event: "error",
						data: {
							message: `会话目录更新失败：${error instanceof Error ? error.message : String(error)}`,
						},
					});
				}
			});
		});
	}
}
