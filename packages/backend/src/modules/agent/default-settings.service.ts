import {
	type DefaultSettings,
	DefaultSettingsSchema,
	UpdateDefaultSettingsInput,
} from "@pi-agent/common";
import { eq } from "drizzle-orm";
import { AppError } from "@/core/app-error";
import { withRuntimeDatabase } from "@/db";
import { userSettings } from "@/db/schema";
import { configuredDefaultThinking, configuredModelSelections } from "./model-config";

type DB = Parameters<Parameters<typeof withRuntimeDatabase>[0]>[0];
function read(db: DB, userId: string) {
	const row = db.select().from(userSettings).where(eq(userSettings.userId, userId)).get();
	const models = configuredModelSelections(userId);
	try {
		const saved = UpdateDefaultSettingsInput.parse(row ? JSON.parse(row.settings) : {});
		const selected = models.find(
			(model) => model.provider === saved.model?.provider && model.modelId === saved.model.modelId,
		);
		const model = selected ?? models[0] ?? null;
		const settings = DefaultSettingsSchema.parse({
			...saved,
			model,
			thinkingLevel:
				(saved.model && !selected ? undefined : saved.thinkingLevel) ??
				(model ? configuredDefaultThinking(userId, model.provider, model.modelId) : "off"),
		});
		return { saved, settings };
	} catch {
		throw new AppError("AGENT_ERROR", "用户默认配置读取失败或损坏，原记录已保留，请检查后重试");
	}
}

export function getDefaultSettings(userId: string): DefaultSettings {
	return withRuntimeDatabase((db) => read(db, userId).settings);
}

export function updateDefaultSettings(
	userId: string,
	patch: UpdateDefaultSettingsInput,
): DefaultSettings {
	return withRuntimeDatabase((db) =>
		db.transaction(() => {
			if (
				patch.model &&
				!configuredModelSelections(userId).some(
					(model) =>
						model.provider === patch.model!.provider && model.modelId === patch.model!.modelId,
				)
			)
				throw new AppError("MODEL_NOT_FOUND", "所选模型未在 models.json 中配置");
			const { saved, settings: current } = read(db, userId);
			const changedModel =
				patch.model !== undefined &&
				(patch.model?.provider !== current.model?.provider ||
					patch.model?.modelId !== current.model?.modelId);
			// 只保存主动选择；模型配置的默认值在读取时计算，避免 GET 将它冻结。
			const next = { ...saved, ...patch };
			if (changedModel && patch.thinkingLevel === undefined) delete next.thinkingLevel;
			if (patch.thinkingLevel !== undefined && patch.model === undefined)
				next.model = current.model;
			db.insert(userSettings)
				.values({ userId, settings: JSON.stringify(next) })
				.onConflictDoUpdate({
					target: userSettings.userId,
					set: { settings: JSON.stringify(next) },
				})
				.run();
			return read(db, userId).settings;
		}),
	);
}
