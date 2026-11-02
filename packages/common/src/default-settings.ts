import { z } from "zod";

export const ThinkingLevelSchema = z.enum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
export const RunModeSchema = z.enum(["auto", "standard", "safe", "plan"]);

const ModelSelectionSchema = z
	.object({ provider: z.string().min(1), modelId: z.string().min(1) })
	.nullable();
export const DefaultSettingsSchema = z.object({
	model: ModelSelectionSchema.default(null),
	thinkingLevel: ThinkingLevelSchema.default("off"),
	runMode: RunModeSchema.default("standard"),
});
export type DefaultSettings = z.infer<typeof DefaultSettingsSchema>;
export const UpdateDefaultSettingsInput = z.object({
	model: ModelSelectionSchema.optional(),
	thinkingLevel: ThinkingLevelSchema.optional(),
	runMode: RunModeSchema.optional(),
});
export type UpdateDefaultSettingsInput = z.infer<typeof UpdateDefaultSettingsInput>;
