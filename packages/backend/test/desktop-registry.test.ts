import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env";
import { SessionRegistry } from "../src/modules/agent/session-registry";
import { configureTestModels } from "./helpers";

test("preserving shutdown suspends before waiting for native agent cleanup", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-desktop-stop-"));
	const original = env.dataDir;
	(env as { dataDir: string }).dataDir = join(root, "data");
	mkdirSync(join(root, "project"));
	const registry = new SessionRegistry();
	try {
		configureTestModels("desktop-stop");
		const ctx = await registry.create(
			{ userId: "desktop-stop", username: "user" },
			join(root, "project"),
		);
		const suspend = spyOn(ctx.recovery!, "suspend");
		const wait = spyOn(ctx.session.agent, "waitForIdle");
		await registry.stop({ preserveRunning: true });
		expect(suspend).toHaveBeenCalledTimes(1);
		expect(wait).toHaveBeenCalledTimes(1);
	} finally {
		await registry.stop();
		(env as { dataDir: string }).dataDir = original;
		rmSync(root, { recursive: true, force: true });
	}
});
