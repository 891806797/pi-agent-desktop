import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env";
import { openSession, setModel, setThinking } from "../src/modules/agent/agent.service";
import {
	getDefaultSettings,
	updateDefaultSettings,
} from "../src/modules/agent/default-settings.service";
import { listModels } from "../src/modules/agent/model.service";
import { registry, SessionRegistry } from "../src/modules/agent/session-registry";
import { encodePath, userAgentDir } from "../src/modules/system/paths";
import { addWorkspace } from "../src/modules/system/workspace-registry";

test("only JSON-declared models are listed, selected and restored in declaration order", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-model-source-"));
	const oldData = env.dataDir;
	const oldKey = process.env.DEEPSEEK_API_KEY;
	(env as { dataDir: string }).dataDir = dir;
	process.env.DEEPSEEK_API_KEY = "host-key-must-not-add-models";
	const user = { userId: crypto.randomUUID(), username: "model-source" };
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	const file = join(userAgentDir(user.userId), "models.json");
	const sessions = new SessionRegistry();
	let providerRequests = 0;
	const provider = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => {
			providerRequests++;
			return new Response(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "should be blocked" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	writeFileSync(
		file,
		JSON.stringify({
			providers: {
				fixture: {
					api: "openai-completions",
					apiKey: "user-key",
					baseUrl: `http://127.0.0.1:${provider.port}/v1`,
					models: [{ id: "z-first" }, { id: "a-second" }],
				},
			},
		}),
	);
	try {
		expect((await listModels(user.userId)).map((m) => `${m.provider}/${m.modelId}`)).toEqual([
			"fixture/z-first",
			"fixture/a-second",
		]);
		expect(getDefaultSettings(user.userId).model).toEqual({
			provider: "fixture",
			modelId: "z-first",
		});
		const ctx = await sessions.create(user, cwd);
		expect(ctx.session.model?.id).toBe("z-first");
		await expect(setModel(user, ctx, "deepseek", "deepseek-flash")).rejects.toThrow();
		await setModel(user, ctx, "fixture", "a-second");
		updateDefaultSettings(user.userId, { model: { provider: "fixture", modelId: "a-second" } });
		expect(getDefaultSettings(user.userId).model?.modelId).toBe("a-second");
		const manualConfig = JSON.parse(readFileSync(file, "utf8"));
		for (const model of manualConfig.providers.fixture.models) model.reasoning = true;
		writeFileSync(file, JSON.stringify(manualConfig));
		expect((await listModels(user.userId))[0]!.supportedThinkingLevels).toContain("high");
		addWorkspace(user.userId, cwd);
		const current = spyOn(registry, "get").mockReturnValue(ctx);
		try {
			await openSession(user, encodePath(cwd), ctx.sessionId);
			expect(ctx.session.getAvailableThinkingLevels()).toContain("high");
			await setThinking(ctx, "high");
			expect(ctx.session.thinkingLevel).toBe("high");
		} finally {
			current.mockRestore();
		}
		ctx.session.settingsManager.applyOverrides({
			compaction: { keepRecentTokens: 256, reserveTokens: 256 },
		});
		for (let index = 0; index < 8; index++) {
			ctx.session.sessionManager.appendMessage({
				role: "user",
				content: "history ".repeat(300),
				timestamp: index * 2,
			});
			ctx.session.sessionManager.appendMessage({
				role: "assistant",
				api: "openai-completions",
				provider: "fixture",
				model: "a-second",
				content: [{ type: "text", text: "history ".repeat(300) }],
				stopReason: "stop",
				timestamp: index * 2 + 1,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		}
		ctx.session.agent.state.messages = ctx.session.sessionManager.buildSessionContext().messages;
		writeFileSync(file, JSON.stringify({ providers: {} }));
		expect(await listModels(user.userId)).toEqual([]);
		expect(getDefaultSettings(user.userId).model).toBeNull();
		await ctx.session.prompt("must not use a removed model");
		expect(providerRequests).toBe(0);
		await expect(ctx.session.compact()).rejects.toThrow("Compaction cancelled");
		expect(providerRequests).toBe(0);
		writeFileSync(file, "broken");
		await ctx.session.prompt("must not fall back after corrupt config");
		expect(providerRequests).toBe(0);
		await expect(ctx.session.compact()).rejects.toThrow("Compaction cancelled");
		expect(providerRequests).toBe(0);
	} finally {
		await sessions.stop();
		provider.stop(true);
		(env as { dataDir: string }).dataDir = oldData;
		if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = oldKey;
		rmSync(dir, { recursive: true, force: true });
	}
});
