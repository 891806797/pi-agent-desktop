/**
 * REST 请求入参 —— POST/PUT 接口请求体/header 校验的唯一真源。
 * zod schema（运行时校验）+ z.infer 类型同名双导出：一处定义，物理无漂移。
 * 后端经 validate.ts vh() 校验；FE 一律 type-only 导入。
 */

import { z } from "zod";
import { RunModeSchema, ThinkingLevelSchema } from "../default-settings";
import { ProviderConfigSchema } from "../model-settings";

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
	q: z.string().max(200).optional(),
	archived: z.enum(["true", "false"]).optional(),
	cursor: z.string().max(4000).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuery>;

export const UpdateSessionInput = z
	.object({
		expectedRevision: z.int().min(1),
		name: z.string().trim().min(1).max(100).optional(),
		archived: z.boolean().optional(),
	})
	.refine((value) => value.name !== undefined || value.archived !== undefined, "未指定修改内容");
export const DeleteSessionInput = z.object({
	expectedRevision: z.int().min(0),
	stopIfRunning: z.boolean().default(false),
});
export const ReadSessionInput = z.object({ noticeVersion: z.int().min(0) });

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
	level: ThinkingLevelSchema,
});
export type SetThinkingInput = z.infer<typeof SetThinkingInput>;

export const SetRunModeInput = z.object({
	mode: RunModeSchema,
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
		providers: z.record(z.string().trim().min(1, "请输入 Provider 标识"), ProviderConfigSchema),
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

// 工作区文件操作只接受可移植的相对路径，物理路径边界由后端再次校验。
export const FilePath = z
	.string()
	.min(1)
	.max(1000)
	.refine(
		(path) =>
			path
				.split("/")
				.every(
					(part) =>
						part.length > 0 &&
						part !== "." &&
						part !== ".." &&
						!/[\\<>:"|?*]/.test(part) &&
						Array.from(part).every((char) => char.charCodeAt(0) >= 32) &&
						!/[. ]$/.test(part) &&
						!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
				),
		"文件路径不合法",
	);
export const FileQuery = z.object({ dir: WORKSPACE_B64, path: FilePath });
export const SaveFileInput = FileQuery.extend({
	content: z.string().max(1_048_576),
	revision: z.string().min(1),
});
export const CreateFileInput = FileQuery.extend({ kind: z.enum(["file", "dir"]) });
export const MoveFileInput = z.object({ dir: WORKSPACE_B64, from: FilePath, to: FilePath });
export const UploadFilesInput = z.object({
	dir: WORKSPACE_B64,
	path: z.union([z.literal(""), FilePath]),
	files: z
		.array(
			z.object({
				name: FilePath.refine((name) => !name.includes("/"), "文件名不能含目录"),
				contentBase64: z
					.string()
					.max(1_398_104)
					.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
			}),
		)
		.min(1)
		.max(10),
});
