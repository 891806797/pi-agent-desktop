import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env";
import { listModels } from "../src/modules/agent/model.service";
import { registry } from "../src/modules/agent/session-registry";
import { configureTestModels } from "./helpers";

test("model choices expose the same thinking capabilities used by the native SDK", async () => {
	const previous = env.dataDir;
	const dir = mkdtempSync(join(tmpdir(), "pi-model-capabilities-"));
	(env as { dataDir: string }).dataDir = dir;
	configureTestModels("test", ["plain", "reasoning"]);
	const stub = spyOn(registry, "modelRuntimeFor").mockResolvedValue({
		refresh: async () => {},
		getModel: (_provider: string, id: string) =>
			id === "plain"
				? { provider: "fixture", id: "plain", reasoning: false }
				: {
						provider: "fixture",
						id: "reasoning",
						reasoning: true,
						thinkingLevelMap: { off: null, minimal: null, xhigh: "high" },
					},
	} as never);
	try {
		const models = await listModels("test");
		expect(models[0]!.supportedThinkingLevels).toEqual(["off"]);
		expect(models[1]!.supportedThinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
	} finally {
		stub.mockRestore();
		(env as { dataDir: string }).dataDir = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
