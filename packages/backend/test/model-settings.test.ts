import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelConfig, ModelSettingsInput } from "@pi-agent/common";
import { env } from "../src/env";
import { setModel, setThinking } from "../src/modules/agent/agent.service";
import {
	getDefaultSettings,
	updateDefaultSettings,
} from "../src/modules/agent/default-settings.service";
import { listModels, saveModelSettings } from "../src/modules/agent/model.service";
import { SessionRegistry } from "../src/modules/agent/session-registry";
import { userAgentDir } from "../src/modules/system/paths";

test("model form rejects duplicate identities, invalid limits and unsupported defaults", () => {
	const config = (models: unknown[]) => ({ providers: { fixture: { models } } });
	expect(ModelSettingsInput.safeParse(config([{ id: "same" }, { id: "same" }])).success).toBe(
		false,
	);
	expect(ModelSettingsInput.safeParse(config([{ id: "bad", contextWindow: 0 }])).success).toBe(
		false,
	);
	expect(ModelSettingsInput.safeParse(config([{ id: "bad", maxTokens: 1.5 }])).success).toBe(false);
	expect(
		ModelSettingsInput.safeParse(
			config([
				{
					id: "bad",
					reasoning: true,
					thinkingLevelMap: { high: null },
					defaultThinkingLevel: "high",
				},
			]),
		).success,
	).toBe(false);
});

test("configured model thinking defaults apply to new selections while session choices survive reopen", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-model-settings-"));
	const oldData = env.dataDir;
	(env as { dataDir: string }).dataDir = dir;
	const user = { userId: crypto.randomUUID(), username: "model-settings" };
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	const sessions = new SessionRegistry();
	try {
		const input = {
			providers: {
				fixture: {
					api: "openai-completions",
					apiKey: "fixture",
					baseUrl: "http://127.0.0.1:1/v1",
					models: [
						{
							id: "first",
							reasoning: true,
							contextWindow: 128000,
							maxTokens: 16384,
							thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
							defaultThinkingLevel: "high",
						} as ModelConfig,
						{ id: "second", reasoning: true, defaultThinkingLevel: "low" } as ModelConfig,
					],
				},
			},
		};
		writeFileSync(join(userAgentDir(user.userId), "models.json"), JSON.stringify(input));
		expect(getDefaultSettings(user.userId).thinkingLevel).toBe("high");
		input.providers.fixture.models[0]!.defaultThinkingLevel = "low";
		input.providers.fixture.models[0]!.thinkingLevelMap = {
			minimal: null,
			medium: null,
			xhigh: null,
			max: null,
		};
		writeFileSync(join(userAgentDir(user.userId), "models.json"), JSON.stringify(input));
		expect(getDefaultSettings(user.userId).thinkingLevel).toBe("low");
		updateDefaultSettings(user.userId, { runMode: "safe" });
		input.providers.fixture.models[0]!.defaultThinkingLevel = "high";
		input.providers.fixture.models[0]!.thinkingLevelMap = {
			minimal: null,
			low: null,
			medium: null,
			xhigh: null,
			max: null,
		};
		writeFileSync(join(userAgentDir(user.userId), "models.json"), JSON.stringify(input));
		expect(getDefaultSettings(user.userId).thinkingLevel).toBe("high");
		await saveModelSettings(user.userId, input);
		const models = await listModels(user.userId);
		expect(models[0]!.supportedThinkingLevels).toEqual(["off", "high"]);
		const ctx = await sessions.create(user, cwd);
		expect(ctx.session.thinkingLevel).toBe("high");
		await setThinking(ctx, "off");
		await setModel(user, ctx, "fixture", "first");
		expect(ctx.session.thinkingLevel).toBe("off");
		await setModel(user, ctx, "fixture", "second");
		expect(ctx.session.thinkingLevel).toBe("low");
		await setThinking(ctx, "medium");
		await sessions.close(ctx.sessionId, "user_close");
		const reopened = await sessions.create(user, cwd, ctx.sessionId);
		expect(reopened.session.thinkingLevel).toBe("medium");
		expect(
			updateDefaultSettings(user.userId, { model: { provider: "fixture", modelId: "second" } })
				.thinkingLevel,
		).toBe("low");
		expect(updateDefaultSettings(user.userId, { thinkingLevel: "high" }).thinkingLevel).toBe(
			"high",
		);
		expect(getDefaultSettings(user.userId).thinkingLevel).toBe("high");
		updateDefaultSettings(user.userId, {
			model: { provider: "fixture", modelId: "first" },
			thinkingLevel: "high",
		});
		input.providers.fixture.models = input.providers.fixture.models.filter(
			(model) => model.id !== "first",
		);
		writeFileSync(join(userAgentDir(user.userId), "models.json"), JSON.stringify(input));
		expect(getDefaultSettings(user.userId).model?.modelId).toBe("second");
		expect(updateDefaultSettings(user.userId, { thinkingLevel: "high" }).thinkingLevel).toBe(
			"high",
		);
	} finally {
		await sessions.stop();
		(env as { dataDir: string }).dataDir = oldData;
		rmSync(dir, { recursive: true, force: true });
	}
});
