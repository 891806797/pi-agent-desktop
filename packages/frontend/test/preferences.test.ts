import { expect, test } from "bun:test";

test("failed preference reads and live updates can recover on send without losing user isolation", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/preferences.ts"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(new TextDecoder().decode(result.stderr)).toBe("");
	expect(result.exitCode).toBe(0);
});
