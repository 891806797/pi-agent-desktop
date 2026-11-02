import { expect, test } from "bun:test";
import { cacheHitRate, type ModelSettingsInput, modelThinkingLevels } from "@pi-agent/common";
import { beijingFormat, messageTime } from "../src/lib/format";
import { buildModelSettings, newProvider, providerDrafts } from "../src/lib/model-settings";

test("message footer uses prompt cache percentage and 24-hour Beijing timestamps", () => {
	expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 700, cacheCreationTokens: 200 })).toBe(
		70,
	);
	expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
	expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull();
	const timestamp = Date.parse("2026-04-02T03:32:56Z");
	expect(beijingFormat(timestamp)).toBe("2026-04-02 11:32:56");
	expect(messageTime(timestamp, timestamp + 86_399_999)).toBe("11:32:56");
	expect(messageTime(timestamp, timestamp + 86_400_000)).toBe("2026-04-02 11:32:56");
	expect(messageTime(Date.parse("2026-04-02T16:00:00Z"), Date.parse("2026-04-02T17:00:00Z"))).toBe(
		"00:00:00",
	);
});

test("model form roundtrip retains native settings, aligns names and rejects duplicate providers", () => {
	const config: ModelSettingsInput = {
		providers: {
			ali: {
				api: "anthropic-messages",
				apiKey: "secret",
				headers: { "x-custom": "keep" },
				models: [
					{
						id: "one",
						name: "old name",
						reasoning: true,
						thinkingLevelMap: { minimal: null, xhigh: "custom" },
						defaultThinkingLevel: "high",
						compat: { supportsStore: false },
					},
				],
			},
		},
		$schema: "native-schema",
	};
	const draft = providerDrafts(config);
	draft[0]!.id = "changed";
	const saved = buildModelSettings(config, draft);
	expect(saved.$schema).toBe("native-schema");
	expect(saved.providers.changed?.headers).toEqual({ "x-custom": "keep" });
	expect(saved.providers.changed?.apiKey).toBe("secret");
	expect(saved.providers.changed?.models?.[0]?.name).toBe("one");
	expect(saved.providers.changed?.models?.[0]?.compat).toEqual({ supportsStore: false });
	expect(modelThinkingLevels(saved.providers.changed!.models![0]!)).toEqual([
		"off",
		"low",
		"medium",
		"high",
		"xhigh",
	]);
	expect(config.providers.ali?.models?.[0]?.name).toBe("old name");
	const extra = newProvider();
	extra.id = "changed";
	expect(() => buildModelSettings(config, [...draft, extra])).toThrow("不能重复");
});
