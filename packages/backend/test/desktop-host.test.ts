import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jwtVerify } from "jose";

const token = "desktop-test-connection-secret";
const entry = resolve(import.meta.dir, "../src/index.ts");

function launch(root: string, extra: Record<string, string> = {}) {
	return Bun.spawn([process.execPath, "--no-env-file", entry], {
		cwd: root,
		env: {
			...process.env,
			PI_OFFLINE: "1",
			PI_DESKTOP_TOKEN: token,
			HOST: "0.0.0.0",
			PORT: "1",
			DATA_DIR: join(root, "data"),
			JWT_SECRET: "",
			...extra,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function ready(child: ReturnType<typeof launch>) {
	const reader = child.stdout.getReader();
	const timeout = setTimeout(() => child.kill(), 8000);
	try {
		let output = "";
		while (!output.includes("\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("sidecar exited without ready frame");
			output += new TextDecoder().decode(chunk.value);
		}
		expect(output.split("\n")[0]).toStartWith('{"type":"ready"');
		const frame = JSON.parse(output.split("\n")[0]);
		expect(frame).toMatchObject({ type: "ready", protocol: 1, version: "0.1.0" });
		expect(new URL(frame.url).hostname).toBe("127.0.0.1");
		expect(new URL(frame.url).port).not.toBe("1");
		return frame.url as string;
	} finally {
		clearTimeout(timeout);
		reader.releaseLock();
	}
}

async function stop(child: ReturnType<typeof launch>, eof = false) {
	if (!eof) child.stdin.write('{"type":"shutdown"}\n{"type":"shutdown"}\n');
	child.stdin.end();
	const timeout = setTimeout(() => child.kill(), 7000);
	try {
		expect(await child.exited).toBe(0);
	} finally {
		clearTimeout(timeout);
	}
}

test("desktop ready, boundary token, no seeded account and bounded duplicate shutdown", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-desktop-"));
	const child = launch(root);
	try {
		const url = await ready(child);
		for (const path of ["api/health", "api/auth/login", "api/user/events", "", "not-found"]) {
			for (const value of [undefined, "wrong", `${token}suffix`]) {
				const response = await fetch(new URL(path, url), {
					headers: value ? { "x-pi-desktop-token": value } : {},
				});
				expect(response.status).toBe(403);
			}
		}
		expect(
			(await fetch(new URL("api/health", url), { headers: { "x-pi-desktop-token": token } }))
				.status,
		).toBe(200);
		const db = new Database(join(root, "data/runtime.sqlite"), { readonly: true });
		try {
			expect(db.query("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
		await stop(child);
		const remaining = child.stdout.getReader();
		let output = "";
		while (true) {
			const chunk = await remaining.read();
			if (chunk.done) break;
			output += new TextDecoder().decode(chunk.value);
		}
		remaining.releaseLock();
		expect(output).not.toContain('"type":"ready"');
		expect(await new Response(child.stderr).text()).not.toContain(token);
		expect(existsSync(join(root, ".env"))).toBe(false);
	} finally {
		child.kill();
		await child.exited;
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);

test("desktop EOF exits and SQLite JWT survives restart without cwd writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-desktop-jwt-"));
	let child = launch(root);
	try {
		let url = await ready(child);
		const login = await fetch(new URL("api/auth/login", url), {
			method: "POST",
			headers: {
				"x-pi-desktop-token": token,
				"content-type": "application/json",
			},
			body: JSON.stringify({ username: "desktop-user", password: "test-password" }),
		});
		expect(login.status).toBe(200);
		const cookie = login.headers.get("set-cookie")!.split(";")[0];
		await stop(child, true);
		child = launch(root);
		url = await ready(child);
		const me = await fetch(new URL("api/auth/me", url), {
			headers: { "x-pi-desktop-token": token, cookie },
		});
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ ok: true, data: { username: "desktop-user" } });
		await stop(child, true);
		expect(existsSync(join(root, ".env"))).toBe(false);
	} finally {
		child.kill();
		await child.exited;
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);

test("explicit JWT secret is preserved without generating a database secret", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-desktop-explicit-"));
	const secret = "explicit-deployment-jwt-secret";
	const child = launch(root, { JWT_SECRET: secret });
	try {
		const url = await ready(child);
		const login = await fetch(new URL("api/auth/login", url), {
			method: "POST",
			headers: {
				"x-pi-desktop-token": token,
				"content-type": "application/json",
			},
			body: JSON.stringify({ username: "explicit-user", password: "test-password" }),
		});
		expect(login.status).toBe(200);
		const cookie = login.headers.get("set-cookie")!.split(";")[0];
		const jwt = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
		expect((await jwtVerify(jwt, new TextEncoder().encode(secret))).payload.username).toBe(
			"explicit-user",
		);
		await stop(child);
		const db = new Database(join(root, "data/runtime.sqlite"), { readonly: true });
		try {
			expect(db.query("SELECT value FROM app_metadata WHERE key = 'jwt_secret'").get()).toBeNull();
		} finally {
			db.close();
		}
	} finally {
		child.kill();
		await child.exited;
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);

for (const mode of ["fail", "timeout"]) {
	test(`desktop ${mode} shutdown exits nonzero without leaking credentials`, async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				resolve(import.meta.dir, "probes/desktop-shutdown.ts"),
				mode,
			],
			{
				env: { ...process.env, PI_DESKTOP_TOKEN: token },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => child.kill(), 8000);
		try {
			const reader = child.stdout.getReader();
			const { value } = await reader.read();
			reader.releaseLock();
			expect(JSON.parse(new TextDecoder().decode(value))).toEqual({
				installed: true,
				tokenInherited: false,
			});
			child.stdin.write('{"type":"shutdown"}\n');
			child.stdin.end();
			expect(await child.exited).toBe(1);
			const error = await new Response(child.stderr).text();
			expect(error).toContain(mode === "fail" ? "shutdown failed" : "shutdown timed out");
			expect(error).not.toContain(token);
		} finally {
			clearTimeout(timer);
			child.kill();
			await child.exited;
		}
	}, 12000);
}
