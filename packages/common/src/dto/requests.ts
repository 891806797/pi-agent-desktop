/**
 * REST 请求入参 —— POST/PUT 接口请求体/header 校验的唯一真源。
 * zod schema（运行时校验）+ z.infer 类型同名双导出：一处定义，物理无漂移。
 * 后端经 validate.ts vh() 校验；FE 一律 type-only 导入。
 */

import { z } from "zod";

// ===== 通用 =====

/** base64url（URL-safe，无 padding）编码的工作空间绝对路径 */
export const WORKSPACE_B64 = z.string().regex(/^[A-Za-z0-9_-]+$/, "base64url 编码的工作目录");

/**
 * 会话操作协议：聊天页所有 REST 请求统一携带 x-session-id + x-workspace-dir。
 * header 仅 Latin-1，Windows 路径含中文/反斜杠必须编码；SSE 端点走 query（EventSource 无自定义 header）。
 */
export const SessionHeaders = z.object({
	"x-session-id": z.uuid(),
	"x-workspace-dir": WORKSPACE_B64,
});
export type SessionHeaders = z.infer<typeof SessionHeaders>;

// ===== auth =====

export const LoginInput = z.object({
	username: z.string().min(1).max(100),
	password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

// ===== agent：会话 =====

export const CreateSessionInput = z.object({
	/** base64url 工作空间路径 */
	workspace: WORKSPACE_B64,
	/** resume 指定会话；缺省新建（uuidV7 由 pi 生成） */
	resumeSessionId: z.uuid().optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;

export const ListSessionsQuery = z.object({
	workspace: WORKSPACE_B64.optional(),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuery>;

// ===== agent：消息与队列 =====

export const SendMessageInput = z.object({
	text: z.string().min(1),
	/** 运行中切入方式；空闲时忽略 */
	behavior: z.enum(["steer", "followUp"]).optional(),
	images: z
		.array(
			z.object({
				type: z.literal("image"),
				data: z
					.string()
					.min(1)
					.max(20_000_000)
					.regex(/^[A-Za-z0-9+/]*={0,2}$/, "图片必须为 base64"),
				mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
			}),
		)
		.max(10)
		.optional(),
});
export type SendMessageInput = z.infer<typeof SendMessageInput>;

export const QueueRemoveInput = z.object({
	index: z.int().min(0),
	behavior: z.enum(["steer", "followUp"]),
	expectedText: z.string().optional(),
	targetBehavior: z.enum(["steer", "followUp"]).optional(),
	revision: z.int().min(0).optional(),
});
export type QueueRemoveInput = z.infer<typeof QueueRemoveInput>;

export const QueueDispatchInput = z.object({
	requestId: z.uuid(),
	index: z.int().min(0),
	behavior: z.enum(["steer", "followUp"]),
	expectedText: z.string(),
	revision: z.int().min(0),
	mode: z.enum(["steer", "stop"]),
});
export type QueueDispatchInput = z.infer<typeof QueueDispatchInput>;

// ===== agent：审批 =====

export const ApprovalActionInput = z.object({
	action: z.enum(["allow", "deny", "answer", "cancel"]),
	/** answer 时的问题答案（结构由 AskQuestionPayload 决定） */
	data: z.unknown().optional(),
});
export type ApprovalActionInput = z.infer<typeof ApprovalActionInput>;

// ===== agent：动态切换 =====

export const SetModelInput = z.object({
	provider: z.string().min(1),
	modelId: z.string().min(1),
});
export type SetModelInput = z.infer<typeof SetModelInput>;

export const SetThinkingInput = z.object({
	level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});
export type SetThinkingInput = z.infer<typeof SetThinkingInput>;

export const SetRunModeInput = z.object({
	mode: z.enum(["auto", "standard", "safe", "plan"]),
});
export type SetRunModeInput = z.infer<typeof SetRunModeInput>;

// ===== system：文件 =====

export const FilesQuery = z.object({
	dir: WORKSPACE_B64,
	q: z.string().max(200).optional(),
});
export type FilesQuery = z.infer<typeof FilesQuery>;

export const AddWorkspaceInput = z.object({ path: z.string().min(1) });
export type AddWorkspaceInput = z.infer<typeof AddWorkspaceInput>;
export const ListDirectoriesQuery = z.object({ path: z.string().optional() });
export type ListDirectoriesQuery = z.infer<typeof ListDirectoriesQuery>;

export const ModelSettingsInput = z
	.object({
		providers: z.record(
			z.string(),
			z
				.object({
					apiKey: z.string().min(1).optional(),
					api: z.string().min(1).optional(),
					baseUrl: z.url().optional(),
					models: z
						.array(
							z.object({ id: z.string().min(1), reasoning: z.boolean().optional() }).passthrough(),
						)
						.optional(),
				})
				.passthrough(),
		),
	})
	.passthrough()
	.superRefine((config, ctx) => {
		// SDK 允许从命令或宿主环境解析认证值；Web 用户配置只接收字面量。
		const check = (value: unknown, path: (string | number)[]) => {
			if (
				typeof value === "string" &&
				(/^!/.test(value.trimStart()) || /(?:^|[^$])(?:\$\$)*\$(?:[A-Za-z_]|\{)/.test(value))
			)
				ctx.addIssue({
					code: "custom",
					path,
					message: "Web 配置请直接填写认证值，不支持命令或服务器环境变量引用",
				});
		};
		const visit = (value: unknown, path: (string | number)[]): void => {
			if (!value || typeof value !== "object") return;
			for (const [key, child] of Object.entries(value)) {
				const childPath = [...path, key];
				if (key === "apiKey") check(child, childPath);
				if (key === "headers" && child && typeof child === "object")
					for (const [name, header] of Object.entries(child)) check(header, [...childPath, name]);
				visit(child, childPath);
			}
		};
		visit(config, []);
	});
export type ModelSettingsInput = z.infer<typeof ModelSettingsInput>;
