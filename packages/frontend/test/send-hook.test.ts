import { expect, test } from "bun:test";

test("pending A does not block B, duplicate B is rejected and old completion keeps B locked", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/send-hook.ts"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(new TextDecoder().decode(result.stderr)).toBe("");
	expect(result.exitCode).toBe(0);
});
