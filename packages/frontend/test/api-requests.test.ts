import { expect, test } from "bun:test";

test("identical metadata reads share in-flight work while writes and live snapshots remain independent", () => {
	const result = Bun.spawnSync([process.execPath, "run", "test/probes/api-requests.ts"], {
		cwd: `${import.meta.dir}/..`,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode) throw new Error(new TextDecoder().decode(result.stderr));
	expect(result.exitCode).toBe(0);
});
