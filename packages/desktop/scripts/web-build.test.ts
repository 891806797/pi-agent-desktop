import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileBackend, hostTarget, repoRoot, run } from "../../backend/scripts/build";

test("compiled Web retains cwd .env PORT/HOST/DATA_DIR configuration", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-web-dotenv-"));
	try {
		if (!existsSync(join(repoRoot, "packages/frontend/dist/index.html"))) {
			await run([process.execPath, "run", "build"], join(repoRoot, "packages/frontend"));
		}
		const executable = join(dir, `pi-agent${process.platform === "win32" ? ".exe" : ""}`);
		const target = hostTarget();
		if (!target) throw new Error("Unsupported test host");
		await compileBackend(target, executable, false);
		const dataDir = join(dir, "dotenv-store");
		writeFileSync(
			join(dir, ".env"),
			`PORT=0\nHOST=127.0.0.1\nDATA_DIR=${dataDir.replaceAll("\\", "/")}\n`,
		);
		const child = Bun.spawn([executable], {
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				SYSTEMROOT: process.env.SYSTEMROOT,
				HOME: dir,
				USERPROFILE: dir,
				PI_OFFLINE: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeout = setTimeout(() => child.kill(), 10000);
		try {
			let output = "";
			for await (const chunk of child.stdout) {
				output += new TextDecoder().decode(chunk);
				const match = output.match(/\[pi-agent\] listening on (https?:\/\/\S+)/);
				if (!match) continue;
				const url = new URL(match[1]!);
				expect(url.hostname).toBe("127.0.0.1");
				expect(url.port).not.toBe("3333");
				expect(existsSync(join(dataDir, "runtime.sqlite"))).toBe(true);
				expect((await fetch(new URL("/api/health", url))).status).toBe(200);
				return;
			}
			throw new Error(
				`Compiled Web exited before listening: ${await new Response(child.stderr).text()}`,
			);
		} finally {
			clearTimeout(timeout);
			child.kill();
			await child.exited;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60000);

test("compiled desktop ignores cwd .env even when Web autoload is preserved", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-desktop-dotenv-"));
	try {
		const executable = join(dir, `sidecar${process.platform === "win32" ? ".exe" : ""}`);
		const target = hostTarget();
		if (!target) throw new Error("Unsupported test host");
		await compileBackend(target, executable, true);
		const forbiddenData = join(dir, "dotenv-must-not-be-read");
		writeFileSync(join(dir, ".env"), `DATA_DIR=${forbiddenData.replaceAll("\\", "/")}\n`);
		const token = crypto.randomUUID();
		const child = Bun.spawn([executable], {
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				SYSTEMROOT: process.env.SYSTEMROOT,
				HOME: dir,
				USERPROFILE: dir,
				PI_OFFLINE: "1",
				PI_DESKTOP_TOKEN: token,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const timeout = setTimeout(() => child.kill(), 10000);
		try {
			let output = "";
			for await (const chunk of child.stdout) {
				output += new TextDecoder().decode(chunk);
				const line = output.split("\n").find((line) => line.startsWith('{"type":"ready"'));
				if (!line) continue;
				const frame = JSON.parse(line);
				expect(frame.protocol).toBe(1);
				expect(existsSync(forbiddenData)).toBe(false);
				expect(existsSync(join(dir, "data/runtime.sqlite"))).toBe(true);
				expect(
					(
						await fetch(new URL("/api/health", frame.url), {
							headers: { "x-pi-desktop-token": token },
						})
					).status,
				).toBe(200);
				child.stdin.write('{"type":"shutdown"}\n');
				child.stdin.end();
				expect(await child.exited).toBe(0);
				return;
			}
			throw new Error(
				`Compiled desktop exited before ready: ${await new Response(child.stderr).text()}`,
			);
		} finally {
			clearTimeout(timeout);
			child.kill();
			await child.exited;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60000);
