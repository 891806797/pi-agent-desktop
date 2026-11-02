import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateDefaultSettingsInput } from "@pi-agent/common";
import { eq } from "drizzle-orm";
import { withRuntimeDatabase } from "../src/db";
import { userSettings } from "../src/db/schema";
import { env } from "../src/env";
import {
	getDefaultSettings,
	updateDefaultSettings,
} from "../src/modules/agent/default-settings.service";
import { configureTestModels } from "./helpers";

test("partial setting updates never invent defaults for fields the user did not change", () => {
	expect(UpdateDefaultSettingsInput.parse({ thinkingLevel: "high" })).toEqual({
		thinkingLevel: "high",
	});
});

test("per-user defaults merge selections, survive rereads and preserve corrupt records", () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-defaults-"));
	const original = env.dataDir;
	(env as { dataDir: string }).dataDir = temp;
	try {
		configureTestModels("one", ["chosen"]);
		expect(getDefaultSettings("one").runMode).toBe("standard");
		updateDefaultSettings("one", { model: { provider: "fixture", modelId: "chosen" } });
		updateDefaultSettings("one", { thinkingLevel: "high", runMode: "safe" });
		expect(getDefaultSettings("one")).toEqual({
			model: { provider: "fixture", modelId: "chosen" },
			thinkingLevel: "high",
			runMode: "safe",
		});
		expect(getDefaultSettings("two").model).toBeNull();
		withRuntimeDatabase((db) =>
			db
				.update(userSettings)
				.set({ settings: "broken" })
				.where(eq(userSettings.userId, "one"))
				.run(),
		);
		expect(() => getDefaultSettings("one")).toThrow("损坏");
		expect(() => updateDefaultSettings("one", { runMode: "auto" })).toThrow("损坏");
		expect(
			withRuntimeDatabase(
				(db) =>
					db.select().from(userSettings).where(eq(userSettings.userId, "one")).get()!.settings,
			),
		).toBe("broken");
	} finally {
		(env as { dataDir: string }).dataDir = original;
		rmSync(temp, { recursive: true, force: true });
	}
});
