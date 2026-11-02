import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelSettingsInput, modelDefaultThinking } from "@pi-agent/common";
import { AppError } from "@/core/app-error";
import { userAgentDir } from "@/modules/system/paths";

/** 模型身份和顺序只来自当前用户的 models.json。 */
export function readModelConfig(userId: string): ModelSettingsInput {
	try {
		return ModelSettingsInput.parse(
			JSON.parse(readFileSync(join(userAgentDir(userId), "models.json"), "utf8")),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
		throw new AppError("BAD_REQUEST", "模型配置读取失败，请检查 models.json 格式");
	}
}

export function configuredModelSelections(userId: string) {
	return Object.entries(readModelConfig(userId).providers).flatMap(([provider, config]) =>
		(config.models ?? []).map(({ id }) => ({ provider, modelId: id })),
	);
}

export function configuredDefaultThinking(userId: string, provider: string, modelId: string) {
	const model = readModelConfig(userId).providers[provider]?.models?.find(
		(model) => model.id === modelId,
	);
	return model ? modelDefaultThinking(model) : "off";
}

export function configuredModels(userId: string, runtime: ModelRuntime) {
	return configuredModelSelections(userId).map(({ provider, modelId }) => {
		const model = runtime.getModel(provider, modelId);
		if (!model)
			throw new AppError("MODEL_NOT_FOUND", `${provider}/${modelId} 配置无效，请检查模型设置`);
		return model;
	});
}

/** 配置在运行中被移除时，在 SDK 请求边界中止，不让后续轮次使用旧模型。 */
export function makeModelConfigGateExt(userId: string) {
	const blockedReason = (ctx: ExtensionContext): string | undefined => {
		const current = ctx.model;
		try {
			if (
				current &&
				configuredModelSelections(userId).some(
					(model) => model.provider === current.provider && model.modelId === current.id,
				)
			)
				return;
		} catch {
			return "模型配置读取失败，请检查 models.json 后重试";
		}
		return "当前模型已从 models.json 移除，请重新选择模型";
	};
	return (pi: ExtensionAPI) => {
		pi.on("before_provider_request", (_event, ctx) => {
			const message = blockedReason(ctx);
			if (!message) return;
			ctx.abort();
			ctx.ui.notify(message, "error");
		});
		pi.on("session_before_compact", (_event, ctx) => {
			const message = blockedReason(ctx);
			if (!message) return;
			ctx.ui.notify(message, "error");
			return { cancel: true };
		});
	};
}
