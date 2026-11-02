import {
	type ModelConfig,
	ModelSettingsInput,
	modelDefaultThinking,
	type ProviderConfig,
} from "@pi-agent/common";

export interface ModelDraft {
	key: string;
	value: ModelConfig;
}
export interface ProviderDraft {
	key: string;
	id: string;
	settings: ProviderConfig;
	models: ModelDraft[];
}

export function newModel(): ModelDraft {
	return {
		key: crypto.randomUUID(),
		value: {
			id: "",
			contextWindow: 128000,
			maxTokens: 16384,
			reasoning: false,
			defaultThinkingLevel: "off",
		},
	};
}
export function newProvider(): ProviderDraft {
	return {
		key: crypto.randomUUID(),
		id: "",
		settings: { api: "openai-completions" },
		models: [newModel()],
	};
}
export function providerDrafts(config: ModelSettingsInput): ProviderDraft[] {
	return Object.entries(config.providers).map(([id, { models, ...settings }]) => ({
		key: crypto.randomUUID(),
		id,
		settings,
		models: (models ?? []).map((model) => ({
			key: crypto.randomUUID(),
			value: {
				...model,
				contextWindow: model.contextWindow ?? 128000,
				maxTokens: model.maxTokens ?? 16384,
				defaultThinkingLevel: modelDefaultThinking(model),
			},
		})),
	}));
}
export function buildModelSettings(
	original: ModelSettingsInput,
	providers: ProviderDraft[],
): ModelSettingsInput {
	const ids = providers.map((provider) => provider.id.trim());
	if (new Set(ids).size !== ids.length) throw new Error("Provider 标识不能重复");
	return ModelSettingsInput.parse({
		...original,
		providers: Object.fromEntries(
			providers.map((provider) => [
				provider.id.trim(),
				{
					...provider.settings,
					models: provider.models.map(({ value }) => ({
						...value,
						id: value.id.trim(),
						name: value.id.trim(),
					})),
				},
			]),
		),
	});
}
