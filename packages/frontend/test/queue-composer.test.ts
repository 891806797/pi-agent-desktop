import { expect, test } from "bun:test";

test("composer queue has two actions, hides delivered steering and retains failed pending input", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/queue-composer.tsx"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(new TextDecoder().decode(result.stderr)).toBe("");
	expect(result.exitCode).toBe(0);
});
