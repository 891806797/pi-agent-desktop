import { expect, test } from "bun:test";

test("chat scrolling coalesces frames, respects user intent and disposes idle work", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/chat-scroll.ts"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(new TextDecoder().decode(result.stderr)).toBe("");
	expect(result.exitCode).toBe(0);
});
