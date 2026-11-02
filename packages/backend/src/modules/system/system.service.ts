import { type Dirent, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { FileItem, WorkspaceInfo } from "@pi-agent/common";
import { encodePath, normalizeWorkspace } from "@/modules/system/paths";
import { addWorkspace, listWorkspaces, resolveWorkspaceB64 } from "./workspace-registry";

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	".venv",
	"__pycache__",
	"target",
	"bin",
]);
const FILE_LIMIT = 2000;

function workspaceInfo(path: string): WorkspaceInfo {
	const normalized = normalizeWorkspace(path);
	return {
		path: normalized,
		encoded: encodePath(normalized),
		name:
			normalized
				.replace(/[\\/]+$/, "")
				.split(/[\\/]/)
				.pop() ?? normalized,
	};
}

export function workspaceList(userId: string): WorkspaceInfo[] {
	return listWorkspaces(userId).map(workspaceInfo);
}
export function registerWorkspace(userId: string, path: string): WorkspaceInfo {
	return workspaceInfo(addWorkspace(userId, path));
}

export function listDirectories(path = "") {
	const entries: Array<{ name: string; path: string }> = [];
	const drives: string[] = [];
	if (!path) {
		if (process.platform === "win32")
			for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
				const drive = `${letter}:\\`;
				try {
					readdirSync(drive);
					drives.push(drive);
				} catch {
					/* 不存在或不可访问的盘符 */
				}
			}
		drives.unshift(homedir());
		return { current: "", entries, drives };
	}
	try {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (entry.isDirectory() && !entry.name.startsWith("."))
				entries.push({ name: entry.name, path: join(path, entry.name) });
		}
	} catch {
		/* 目录选择器对无权限或不存在的目录返回空列表 */
	}
	return { current: path, entries, drives };
}

export function listFiles(userId: string, workspaceB64: string, query?: string): FileItem[] {
	const root = resolveWorkspaceB64(userId, workspaceB64);
	const out: FileItem[] = [];
	const q = query?.toLowerCase();
	const walk = (dir: string, rel: string, depth: number): void => {
		if (out.length >= FILE_LIMIT || depth > 12) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (out.length >= FILE_LIMIT) return;
			if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name) || entry.isSymbolicLink())
				continue;
			const child = posix.join(rel, entry.name);
			if (!q || child.toLowerCase().includes(q))
				out.push({ path: child, name: entry.name, isDir: entry.isDirectory() });
			if (entry.isDirectory()) walk(join(dir, entry.name), child, depth + 1);
		}
	};
	walk(root, "", 0);
	return out;
}
