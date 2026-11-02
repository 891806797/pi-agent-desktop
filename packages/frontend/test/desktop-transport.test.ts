import { expect, test } from "bun:test";

test("desktop HTTP and SSE preserve status, cancellation and late-callback isolation", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/desktop-transport.ts"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode) throw new Error(new TextDecoder().decode(result.stderr));
	expect(result.exitCode).toBe(0);
});
