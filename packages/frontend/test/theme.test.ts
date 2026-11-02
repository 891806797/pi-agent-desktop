import { expect, test } from "bun:test";

test("themes cycle, persist, synchronize tabs and survive unavailable storage", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/theme.ts"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(new TextDecoder().decode(result.stderr)).toBe("");
	expect(result.exitCode).toBe(0);
});
