import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { DesktopShellHost } from "../src/modules/system/desktop-shell";

function alive(pid: number) {
	try {
		return !execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" })
			.trim()
			.startsWith("Z");
	} catch {
		return false;
	}
}

test.skipIf(process.platform === "win32")(
	"stop is idempotent while active executions are rejected and reaped",
	async () => {
		const host = new DesktopShellHost();
		const running = [1, 2].map(() =>
			host.operations().exec("sleep 90", process.cwd(), { onData() {} }),
		);
		const shutdown = host.stop();
		expect(host.stop()).toBe(shutdown);
		const results = await Promise.allSettled(running);
		await shutdown;
		expect(results.every((result) => result.status === "rejected")).toBe(true);
		await expect(host.operations().exec("true", process.cwd(), { onData() {} })).rejects.toThrow(
			"stopping",
		);
	},
	10000,
);

test.skipIf(process.platform === "win32")(
	"custom user shell is preserved independently of the Bash supervisor",
	async () => {
		const host = new DesktopShellHost();
		try {
			let output = "";
			expect(
				(
					await host.operations("/bin/sh").exec("printf custom; exit 4", process.cwd(), {
						onData: (chunk) => {
							output += chunk;
						},
					})
				).exitCode,
			).toBe(4);
			expect(output).toBe("custom");
		} finally {
			await host.stop();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"stdout completion preserves a megabyte and its exact final bytes",
	async () => {
		const host = new DesktopShellHost();
		try {
			const chunks: Buffer[] = [];
			await host.operations().exec("head -c 1048576 /dev/zero; printf tail-marker", process.cwd(), {
				onData: (chunk) => {
					chunks.push(chunk);
				},
			});
			const output = Buffer.concat(chunks);
			expect(output.length).toBe(1048576 + "tail-marker".length);
			expect(output.subarray(-11).toString()).toBe("tail-marker");
		} finally {
			await host.stop();
		}
	},
	10000,
);

test.skipIf(process.platform === "win32")(
	"successful shell background survives command and is terminated at host shutdown",
	async () => {
		const host = new DesktopShellHost();
		let pid = 0;
		let output = "";
		try {
			const result = await host
				.operations()
				.exec("sleep 90 </dev/null >/dev/null 2>&1 & echo $!", process.cwd(), {
					onData: (data) => {
						output += data;
					},
				});
			pid = Number(output.trim());
			expect(result.exitCode).toBe(0);
			expect(alive(pid)).toBe(true);
			await host.stop();
			await Bun.sleep(100);
			expect(alive(pid)).toBe(false);
		} finally {
			if (pid && alive(pid)) process.kill(pid, "SIGKILL");
			await host.stop();
		}
	},
	10000,
);

test.skipIf(process.platform === "win32")(
	"empty commands release anchors and preserve exit/output and stdin semantics",
	async () => {
		const host = new DesktopShellHost();
		try {
			for (let i = 0; i < 5; i++)
				expect(
					(await host.operations().exec("true", process.cwd(), { onData() {} })).exitCode,
				).toBe(0);
			let output = "";
			expect(
				(
					await host.operations().exec("read input || printf eof; exit 7", process.cwd(), {
						onData: (chunk) => {
							output += chunk;
						},
					})
				).exitCode,
			).toBe(7);
			expect(output).toBe("eof");
			const processes = execFileSync("ps", ["-axo", "ppid=,command="], { encoding: "utf8" });
			expect(
				processes
					.split("\n")
					.filter(
						(line) =>
							Number(line.trim().split(/\s+/)[0]) === process.pid &&
							line.includes("pi-desktop-shell"),
					),
			).toHaveLength(0);
		} finally {
			await host.stop();
		}
	},
	10000,
);

test.skipIf(process.platform === "win32")(
	"abort, timeout and missing completion frame terminate the owned group",
	async () => {
		const host = new DesktopShellHost();
		try {
			const abort = new AbortController();
			let pid = 0;
			const operation = host.operations().exec("sleep 90 & echo $!; wait", process.cwd(), {
				signal: abort.signal,
				onData: (chunk) => {
					pid = Number(chunk.toString().trim());
					abort.abort();
				},
			});
			await expect(operation).rejects.toThrow("aborted");
			await Bun.sleep(50);
			expect(pid).toBeGreaterThan(0);
			expect(alive(pid)).toBe(false);
			await expect(
				host.operations().exec("sleep 90", process.cwd(), { timeout: 0.05, onData() {} }),
			).rejects.toThrow("timeout:");
			await expect(
				host
					.operations()
					.exec("kill -KILL -- -$(ps -o pgid= -p $$ | tr -d ' ')", process.cwd(), { onData() {} }),
			).rejects.toThrow();
			await expect(
				host.operations().exec("true", process.cwd(), { timeout: Number.NaN, onData() {} }),
			).rejects.toThrow("Invalid timeout");
			await host.stop();
			await expect(host.operations().exec("true", process.cwd(), { onData() {} })).rejects.toThrow(
				"stopping",
			);
		} finally {
			await host.stop();
		}
	},
	10000,
);

test.skipIf(process.platform === "win32")(
	"naturally completed background work releases its anchor",
	async () => {
		const host = new DesktopShellHost();
		let pid = 0;
		try {
			await host
				.operations()
				.exec("sleep 0.2 </dev/null >/dev/null 2>&1 & echo $!", process.cwd(), {
					onData: (data) => {
						pid = Number(data.toString().trim());
					},
				});
			await Bun.sleep(1400);
			expect(alive(pid)).toBe(false);
			const processes = execFileSync("ps", ["-axo", "ppid=,command="], { encoding: "utf8" });
			expect(
				processes
					.split("\n")
					.filter(
						(line) =>
							Number(line.trim().split(/\s+/)[0]) === process.pid &&
							line.includes("pi-desktop-shell"),
					),
			).toHaveLength(0);
		} finally {
			if (pid && alive(pid)) process.kill(pid, "SIGKILL");
			await host.stop();
		}
	},
	10000,
);
