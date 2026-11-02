import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function alive(pid: number) {
	try {
		return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
			.trim()
			.startsWith("Z");
	} catch {
		return false;
	}
}

for (const mode of ["shutdown", "EOF", "running"]) {
	test.skipIf(process.platform === "win32")(
		`native SDK bash and user_bash processes are cleaned on ${mode}`,
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-shell-sdk-"));
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					resolve(import.meta.dir, "probes/desktop-shell-sdk.ts"),
					mode,
				],
				{
					cwd: root,
					env: {
						...process.env,
						PI_DESKTOP_TOKEN: "fixture",
						PI_OFFLINE: "1",
						DATA_DIR: join(root, "data"),
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const timer = setTimeout(() => child.kill(), 15000);
			let pids: number[] = [];
			try {
				const reader = child.stdout.getReader();
				let frame = "";
				while (!frame.includes("\n")) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error(await new Response(child.stderr).text());
					frame += new TextDecoder().decode(chunk.value);
				}
				reader.releaseLock();
				pids = JSON.parse(frame).pids;
				expect(pids).toHaveLength(mode === "running" ? 1 : 2);
				for (const pid of pids) {
					expect(pid).toBeGreaterThan(0);
					expect(alive(pid)).toBe(true);
				}
				if (mode === "running") child.kill("SIGKILL");
				else {
					if (mode === "shutdown") child.stdin.write('{"type":"shutdown"}\n');
					child.stdin.end();
				}
				const exit = await child.exited;
				if (mode !== "running") expect(exit).toBe(0);
				await Bun.sleep(300);
				for (const pid of pids) expect(alive(pid)).toBe(false);
			} finally {
				clearTimeout(timer);
				child.kill();
				await child.exited;
				for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
				rmSync(root, { recursive: true, force: true });
			}
		},
		20000,
	);
}
