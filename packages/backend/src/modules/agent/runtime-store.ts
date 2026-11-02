import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PendingPayload } from "@pi-agent/common";
import { type DefaultSettings, DefaultSettingsSchema, RunIssueSchema } from "@pi-agent/common";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { AppError } from "@/core/app-error";
import { openRuntimeDatabase } from "@/db";
import { sessionActions, sessionRuntime, sessionSettings } from "@/db/schema";

type NativeResult = Extract<AgentSessionEvent, { type: "tool_execution_end" }>["result"];
const approval = z.object({
	request: z.object({
		requestId: z.string(),
		kind: z.enum([
			"tool_permission",
			"ask_question",
			"ui_select",
			"ui_confirm",
			"ui_input",
			"ui_editor",
		]),
		origin: z.object({ toolCallId: z.string(), ordinal: z.int().min(0) }).optional(),
		payload: z.custom<PendingPayload>((value) => value !== null && typeof value === "object"),
		createdAt: z.number(),
		expiresAt: z.number().optional(),
	}),
	outcome: z
		.object({
			action: z.enum(["allow", "deny", "answer", "cancelled"]),
			data: z.unknown().optional(),
			reason: z.string().optional(),
		})
		.optional(),
});
const input = z.object({
	id: z.string(),
	text: z.string(),
	images: z
		.array(z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }))
		.optional(),
	prepared: z.boolean(),
	behavior: z.enum(["steer", "followUp"]),
	phase: z.enum(["pending", "direct", "queued", "delivering"]),
	position: z.number().optional(),
	expected: z.object({ timestamp: z.number(), ordinal: z.number() }).optional(),
});
const tool = z
	.object({
		toolCallId: z.string(),
		name: z.string(),
		input: z.record(z.string(), z.unknown()),
		parentToolCallId: z.string().optional(),
		phase: z.enum(["started", "completed"]),
		result: z
			.custom<NativeResult>(
				(value) =>
					value !== null &&
					typeof value === "object" &&
					Array.isArray((value as { content?: unknown }).content),
			)
			.optional(),
		isError: z.boolean().optional(),
		durationMs: z.number().optional(),
	})
	.refine(
		(value) => value.phase !== "completed" || value.result !== undefined,
		"已完成工具必须保留执行结果",
	);
const checkpoint = z.object({
	version: z.literal(1),
	userId: z.string().regex(/^[A-Za-z0-9_-]+$/),
	username: z.string(),
	sessionId: z.string().regex(/^[A-Za-z0-9._-]+$/),
	cwd: z.string(),
	active: z.boolean(),
	inputs: z.array(input),
	approvals: z.array(approval),
	tools: z.array(tool),
	issue: RunIssueSchema.optional(),
	attemptId: z.string().optional(),
	intent: z.object({ actionId: z.string(), attemptId: z.string(), issueId: z.string() }).optional(),
});
export type RuntimeCheckpoint = z.infer<typeof checkpoint>;
export type RecoveryInput = RuntimeCheckpoint["inputs"][number];
export type RecoveryTool = RuntimeCheckpoint["tools"][number];

/** 单实例运行检查点；每次替换由 SQLite 原子提交，与 SDK 历史分别持有明确职责。 */
export class RuntimeStore {
	private db: ReturnType<typeof openRuntimeDatabase>;
	constructor(file: string) {
		this.db = openRuntimeDatabase(file);
	}
	readSettings(userId: string, sessionId: string): DefaultSettings | undefined {
		const row = this.db
			.select()
			.from(sessionSettings)
			.where(and(eq(sessionSettings.userId, userId), eq(sessionSettings.sessionId, sessionId)))
			.get();
		if (!row) return;
		try {
			return DefaultSettingsSchema.parse(JSON.parse(row.settings));
		} catch {
			throw new AppError("AGENT_ERROR", "会话配置损坏，已保留原记录，请检查后再恢复");
		}
	}
	writeSettings(userId: string, sessionId: string, settings: DefaultSettings) {
		this.db
			.insert(sessionSettings)
			.values({ userId, sessionId, settings: JSON.stringify(settings) })
			.onConflictDoUpdate({
				target: [sessionSettings.userId, sessionSettings.sessionId],
				set: { settings: JSON.stringify(settings) },
			})
			.run();
	}
	forgetSettings(userId: string, sessionId: string) {
		this.db
			.delete(sessionSettings)
			.where(and(eq(sessionSettings.userId, userId), eq(sessionSettings.sessionId, sessionId)))
			.run();
	}
	read(userId: string, sessionId: string): RuntimeCheckpoint | undefined {
		const row = this.db
			.select({ state: sessionRuntime.state })
			.from(sessionRuntime)
			.where(and(eq(sessionRuntime.userId, userId), eq(sessionRuntime.sessionId, sessionId)))
			.get();
		if (!row) return undefined;
		try {
			const value = checkpoint.parse(JSON.parse(row.state));
			if (value.userId !== userId || value.sessionId !== sessionId)
				throw new Error("owner mismatch");
			return value;
		} catch {
			throw new AppError("AGENT_ERROR", "会话恢复检查点损坏，已阻止自动执行，请保留数据并检查");
		}
	}
	write(value: RuntimeCheckpoint): void {
		const state = JSON.stringify(value);
		this.db
			.insert(sessionRuntime)
			.values({ userId: value.userId, sessionId: value.sessionId, state })
			.onConflictDoUpdate({
				target: [sessionRuntime.userId, sessionRuntime.sessionId],
				set: { state },
			})
			.run();
	}
	remove(userId: string, sessionId: string): void {
		this.db
			.delete(sessionRuntime)
			.where(and(eq(sessionRuntime.userId, userId), eq(sessionRuntime.sessionId, sessionId)))
			.run();
	}
	action(userId: string, actionId: string): string | undefined {
		return this.db
			.select({ state: sessionActions.state })
			.from(sessionActions)
			.where(and(eq(sessionActions.userId, userId), eq(sessionActions.actionId, actionId)))
			.get()?.state;
	}
	claimAction(value: RuntimeCheckpoint, actionId: string, signature: string): void {
		this.db.transaction(() => {
			this.db
				.insert(sessionActions)
				.values({ userId: value.userId, sessionId: value.sessionId, actionId, state: signature })
				.run();
			this.write(value);
		});
	}
	forgetActions(userId: string, sessionId: string): void {
		this.db
			.delete(sessionActions)
			.where(and(eq(sessionActions.userId, userId), eq(sessionActions.sessionId, sessionId)))
			.run();
	}
	list(): Array<{ userId: string; sessionId: string }> {
		return this.db
			.select({ userId: sessionRuntime.userId, sessionId: sessionRuntime.sessionId })
			.from(sessionRuntime)
			.all();
	}
	close(): void {
		this.db.$client.close(true);
	}
}
