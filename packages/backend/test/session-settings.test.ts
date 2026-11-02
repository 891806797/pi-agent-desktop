import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openRuntimeDatabase } from "../src/db";
import { sessionSettings } from "../src/db/schema";
import { env } from "../src/env";
import { setModel, setRunMode, setThinking } from "../src/modules/agent/agent.service";
import { updateDefaultSettings } from "../src/modules/agent/default-settings.service";
import { RuntimeStore } from "../src/modules/agent/runtime-store";
import { registry, SessionRegistry } from "../src/modules/agent/session-registry";
import { userAgentDir, userSessionsDir } from "../src/modules/system/paths";

test("session settings contain four fields and enforce one row per owner/session", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-settings-schema-"));
	const db = openRuntimeDatabase(join(dir, "runtime.sqlite"));
	try {
		const record = { userId: "u", sessionId: "s", settings: '{"thinkingLevel":"high"}' };
		db.insert(sessionSettings).values(record).run();
		expect(db.select().from(sessionSettings).get()).toEqual({
			id: 1,
			...record,
		});
		expect(() => db.insert(sessionSettings).values(record).run()).toThrow();
	} finally {
		db.$client.close(true);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session settings are independent JSON records and restore each session instead of current user defaults", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-settings-"));
	const previous = env.dataDir;
	(env as { dataDir: string }).dataDir = join(dir, "data");
	const cwd = join(dir, "project");
	mkdirSync(cwd);
	const user = { userId: "settings-owner", username: "user" };
	const first = new SessionRegistry(),
		next = new SessionRegistry();
	let stub: ReturnType<typeof spyOn> | undefined;
	try {
		writeFileSync(
			join(userAgentDir(user.userId), "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						api: "openai-completions",
						apiKey: "local-test",
						baseUrl: "http://127.0.0.1:9/v1",
						models: [
							{ id: "a", reasoning: true, contextWindow: 8192, maxTokens: 256 },
							{ id: "b", reasoning: true, contextWindow: 8192, maxTokens: 256 },
						],
					},
				},
			}),
		);
		const a = await first.create(user, cwd),
			b = await first.create(user, cwd);
		stub = spyOn(registry, "modelRuntimeFor").mockResolvedValue(a.session.modelRuntime);
		await setModel(user, a, "fixture", "b");
		await setThinking(a, "high");
		setRunMode(a, "safe");
		await setModel(user, b, "fixture", "a");
		await setThinking(b, "low");
		setRunMode(b, "plan");
		for (const ctx of [a, b])
			ctx.session.sessionManager.appendMessage({ role: "user", content: "history", timestamp: 1 });
		updateDefaultSettings(user.userId, {
			model: { provider: "fixture", modelId: "a" },
			thinkingLevel: "off",
			runMode: "auto",
		});
		await first.stop({ preserveRunning: true });
		const store = new RuntimeStore(join(env.dataDir, "runtime.sqlite"));
		try {
			expect(store.readSettings(user.userId, a.sessionId)).toMatchObject({
				model: { modelId: "b" },
				thinkingLevel: "high",
				runMode: "safe",
			});
			expect(store.readSettings("other", a.sessionId)).toBeUndefined();
		} finally {
			store.close();
		}
		SessionManager.open(
			SessionManager.findById(cwd, a.sessionId, userSessionsDir(user.userId))!,
		).appendThinkingLevelChange("off");
		const restoredA = await next.create(user, cwd, a.sessionId),
			restoredB = await next.create(user, cwd, b.sessionId);
		expect([
			restoredA.session.model?.id,
			restoredA.session.thinkingLevel,
			restoredA.runMode.mode,
		]).toEqual(["b", "high", "safe"]);
		expect([
			restoredB.session.model?.id,
			restoredB.session.thinkingLevel,
			restoredB.runMode.mode,
		]).toEqual(["a", "low", "plan"]);
	} finally {
		stub?.mockRestore();
		await first.stop();
		await next.stop();
		(env as { dataDir: string }).dataDir = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
