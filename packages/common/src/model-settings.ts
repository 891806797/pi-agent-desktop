import { z } from "zod";
import { ThinkingLevelSchema } from "./default-settings";
import type { ThinkingLevel } from "./messages";

export const THINKING_LEVELS = ThinkingLevelSchema.options;
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	minimal: "极低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最高",
};

/** 与 pi getSupportedThinkingLevels 相同：null 禁用，xhigh/max 需显式映射。 */
export function modelThinkingLevels(model: {
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter(
		(level) =>
			model.thinkingLevelMap?.[level] !== null &&
			((level !== "xhigh" && level !== "max") || model.thinkingLevelMap?.[level] !== undefined),
	);
}

export const ModelConfigSchema = z
	.object({
		id: z.string().trim().min(1, "请输入模型 ID"),
		name: z.string().min(1).optional(),
		contextWindow: z.number().int().positive("上下文窗口必须为正整数").optional(),
		maxTokens: z.number().int().positive("最大输出必须为正整数").optional(),
		reasoning: z.boolean().optional(),
		thinkingLevelMap: z.partialRecord(ThinkingLevelSchema, z.string().min(1).nullable()).optional(),
		/** Web 的模型初始偏好；具体能力及请求值仍使用 pi 原生 thinkingLevelMap。 */
		defaultThinkingLevel: ThinkingLevelSchema.optional(),
	})
	.passthrough()
	.superRefine((model, ctx) => {
		const levels = modelThinkingLevels(model);
		if (!levels.length || (model.reasoning && !levels.some((level) => level !== "off")))
			ctx.addIssue({
				code: "custom",
				path: ["thinkingLevelMap"],
				message: "请至少选择一种开启思考的强度",
			});
		if (model.defaultThinkingLevel && !levels.includes(model.defaultThinkingLevel))
			ctx.addIssue({
				code: "custom",
				path: ["defaultThinkingLevel"],
				message: "默认强度必须在支持的思考强度中",
			});
	});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ProviderConfigSchema = z
	.object({
		apiKey: z.string().min(1).optional(),
		api: z.string().min(1).optional(),
		baseUrl: z.url().optional(),
		models: z.array(ModelConfigSchema).optional(),
	})
	.passthrough()
	.superRefine((provider, ctx) => {
		const seen = new Set<string>();
		provider.models?.forEach((model, index) => {
			if (seen.has(model.id))
				ctx.addIssue({
					code: "custom",
					path: ["models", index, "id"],
					message: "同一 Provider 下模型 ID 不能重复",
				});
			seen.add(model.id);
		});
	});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export function modelDefaultThinking(model: ModelConfig): ThinkingLevel {
	const levels = modelThinkingLevels(model);
	return model.defaultThinkingLevel ?? (levels.includes("off") ? "off" : (levels[0] ?? "off"));
}
