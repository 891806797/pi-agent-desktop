import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env";
import { authenticate, ensureSeed, listAuthUsers } from "../src/modules/auth/users";

test("first login registers once, concurrent logins cannot replace passwords, and existing passwords are checked", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-users-sqlite-"));
	const previous = env.dataDir;
	(env as { dataDir: string }).dataDir = dir;
	try {
		const result = await authenticate("new-user", "first-password");
		expect(result?.username).toBe("new-user");
		expect(await authenticate("new-user", "wrong-password")).toBeNull();
		expect((await authenticate("new-user", "first-password"))?.userId).toBe(result!.userId);
		const concurrent = await Promise.all([
			authenticate("race", "password-one"),
			authenticate("race", "password-two"),
		]);
		expect(concurrent.filter(Boolean)).toHaveLength(1);
		expect(listAuthUsers().filter((user) => user.username === "race")).toHaveLength(1);
	} finally {
		(env as { dataDir: string }).dataDir = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("development seed is created once and never replaces registered users", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-users-seed-"));
	const previous = env.dataDir;
	(env as { dataDir: string }).dataDir = dir;
	try {
		ensureSeed();
		const admin = await authenticate("admin", "admin123");
		expect(admin?.username).toBe("admin");
		ensureSeed();
		expect(listAuthUsers()).toEqual([admin!]);
		const registered = await authenticate("registered", "own-password");
		ensureSeed();
		expect(listAuthUsers()).toHaveLength(2);
		expect(await authenticate("registered", "own-password")).toEqual(registered);
	} finally {
		(env as { dataDir: string }).dataDir = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
