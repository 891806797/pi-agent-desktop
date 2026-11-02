import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env";
import { encodePath } from "../src/modules/system/paths";
import {
	addWorkspace,
	listWorkspaces,
	resolveWorkspaceB64,
} from "../src/modules/system/workspace-registry";

test("workspaces isolate users, initialize once and retain stable project order", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-user-workspaces-"));
	const previous = { data: env.dataDir, roots: env.workspaceRoots };
	(env as { dataDir: string }).dataDir = dir;
	(env as { workspaceRoots: string[] }).workspaceRoots = [];
	const a = join(dir, "a"),
		b = join(dir, "b");
	mkdirSync(a);
	mkdirSync(b);
	try {
		(env as { workspaceRoots: string[] }).workspaceRoots = [a, a];
		expect(listWorkspaces("one")).toEqual([a]);
		(env as { workspaceRoots: string[] }).workspaceRoots = [];
		expect(listWorkspaces("new")).toEqual([]);
		addWorkspace("new", b);
		addWorkspace("new", b);
		expect(listWorkspaces("new")).toEqual([b]);
		expect(() => resolveWorkspaceB64("one", encodePath(b))).toThrow();
		expect(() => resolveWorkspaceB64("new", encodePath(a))).toThrow();
		addWorkspace("one", b);
		expect(listWorkspaces("one")).toEqual([a, b]);
		(env as { workspaceRoots: string[] }).workspaceRoots = [a];
		expect(listWorkspaces("new")).toEqual([b]);
	} finally {
		(env as { dataDir: string }).dataDir = previous.data;
		(env as { workspaceRoots: string[] }).workspaceRoots = previous.roots;
		rmSync(dir, { recursive: true, force: true });
	}
});
