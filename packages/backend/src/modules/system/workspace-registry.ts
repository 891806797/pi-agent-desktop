/**
 * 工作空间注册表 —— 持久化用户可用的项目目录白名单。
 *
 * 初始：env.WORKSPACE_ROOTS（启动时一次性 seed 进 data/workspaces.json）；
 * 之后 POST /api/workspaces 增删，运行期读文件。所有会话 cwd 必须 in 白名单。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "@/core/app-error";
import { env } from "@/env";
import {
	containsPath,
	decodePath,
	normalizeWorkspace,
	resolveRealPath,
} from "@/modules/system/paths";

const FILE = () => join(env.dataDir, "workspaces.json");

interface Store {
	roots: string[];
}

let cache: string[] | null = null;

function load(): string[] {
	if (cache !== null) return cache;
	let store: Store;
	if (existsSync(FILE())) {
		try {
			store = JSON.parse(readFileSync(FILE(), "utf8")) as Store;
		} catch {
			store = { roots: [] };
		}
	} else {
		// 首启动：用 env.WORKSPACE_ROOTS seed
		store = { roots: env.workspaceRoots.slice() };
		persist(store.roots);
	}
	cache = store.roots;
	return cache;
}

function persist(roots: string[]): void {
	mkdirSync(env.dataDir, { recursive: true });
	writeFileSync(FILE(), `${JSON.stringify({ roots }, null, 2)}\n`, "utf8");
	cache = roots;
}

export function listWorkspaces(): string[] {
	return load().slice();
}

/** 新增项目目录：resolve + 校验存在 + 去重，返回归一化路径；重复返回原值 */
export function addWorkspace(rawPath: string): string {
	const path = resolve(rawPath);
	if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error("目录不存在");
	const roots = load();
	const hit = roots.find((r) => resolve(r) === path);
	if (hit) return resolve(hit);
	roots.push(path);
	persist(roots);
	return path;
}

/** 白名单同时检查逻辑路径和物理路径，阻止符号链接逃逸。 */
export function isWorkspaceAllowed(p: string): boolean {
	const r = resolve(p);
	return load().some((root) => {
		try {
			return containsPath(root, r) && containsPath(resolveRealPath(root), resolveRealPath(r));
		} catch {
			return false;
		}
	});
}

/** 工作区授权属于业务规则，基础路径模块不依赖注册表。 */
export function resolveWorkspaceB64(b64: string): string {
	const workspace = normalizeWorkspace(decodePath(b64));
	if (!isWorkspaceAllowed(workspace)) throw new AppError("WORKSPACE_DENIED");
	return workspace;
}
