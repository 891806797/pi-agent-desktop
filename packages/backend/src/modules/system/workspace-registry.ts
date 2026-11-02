/** 用户项目清单存于 SQLite，按用户隔离并保留注册顺序。 */
import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { AppError } from "@/core/app-error";
import { withRuntimeDatabase } from "@/db";
import { appMetadata, userWorkspaces } from "@/db/schema";
import { env } from "@/env";
import { containsPath, decodePath, normalizeWorkspace, resolveRealPath } from "./paths";

type DB = Parameters<Parameters<typeof withRuntimeDatabase>[0]>[0];
function initialize(db: DB, userId: string) {
	const key = `workspaces:${userId}`;
	if (db.select().from(appMetadata).where(eq(appMetadata.key, key)).get()) return;
	for (const [position, workspace] of [
		...new Set(env.workspaceRoots.map((path) => resolve(path))),
	].entries())
		db.insert(userWorkspaces).values({ userId, workspace, position }).onConflictDoNothing().run();
	db.insert(appMetadata).values({ key, value: "initialized" }).run();
}
export function listWorkspaces(userId: string): string[] {
	return withRuntimeDatabase((db) =>
		db.transaction(() => {
			initialize(db, userId);
			return db
				.select()
				.from(userWorkspaces)
				.where(eq(userWorkspaces.userId, userId))
				.orderBy(asc(userWorkspaces.position), asc(userWorkspaces.workspace))
				.all()
				.map((row) => row.workspace);
		}),
	);
}
export function addWorkspace(userId: string, rawPath: string): string {
	const path = resolve(rawPath);
	try {
		if (!statSync(path).isDirectory()) throw new Error();
	} catch {
		throw new AppError("BAD_REQUEST", "项目目录不存在或无法访问");
	}
	return withRuntimeDatabase((db) =>
		db.transaction(() => {
			initialize(db, userId);
			const existing = db
				.select()
				.from(userWorkspaces)
				.where(eq(userWorkspaces.userId, userId))
				.all()
				.find((row) => relative(row.workspace, path) === "");
			if (existing) return existing.workspace;
			const row = db
				.select({ position: sql<number>`coalesce(max(${userWorkspaces.position}), -1) + 1` })
				.from(userWorkspaces)
				.where(eq(userWorkspaces.userId, userId))
				.get();
			db.insert(userWorkspaces).values({ userId, workspace: path, position: row!.position }).run();
			return path;
		}),
	);
}
export function isWorkspaceAllowed(userId: string, path: string): boolean {
	return listWorkspaces(userId).some((root) => {
		try {
			return containsPath(root, path) && containsPath(resolveRealPath(root), resolveRealPath(path));
		} catch {
			return false;
		}
	});
}
export function resolveWorkspaceB64(userId: string, b64: string): string {
	const path = normalizeWorkspace(decodePath(b64));
	if (!isWorkspaceAllowed(userId, path)) throw new AppError("WORKSPACE_DENIED");
	return path;
}
