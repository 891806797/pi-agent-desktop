/**
 * 路径归一化与 per-user 数据目录 —— 多用户安全边界。
 *
 * 工作空间白名单：WORKSPACE_ROOTS（分号分隔）内目录为合法会话 cwd。
 * 文件类操作同时校验相对关系和物理路径，防目录与符号链接逃逸。
 */

import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError } from "@/core/app-error";
import { env } from "@/env";

// ===== base64url（URL-safe，无 padding）=====

export function encodePath(p: string): string {
	return Buffer.from(p, "utf8").toString("base64url");
}

export function decodePath(b64: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(b64)) throw new AppError("BAD_REQUEST", "工作空间编码不合法");
	try {
		const path = Buffer.from(b64, "base64url").toString("utf8");
		if (!isAbsolute(path)) throw new AppError("BAD_REQUEST", "工作空间必须是绝对路径");
		return path;
	} catch {
		throw new AppError("BAD_REQUEST", "工作空间编码不合法");
	}
}

// ===== 工作空间 =====

/** 归一化绝对路径，大小写比较由平台的 path.relative 处理。 */
export function normalizeWorkspace(p: string): string {
	const resolved = resolve(p);
	return resolved;
}

// ===== per-user 数据目录 =====

function userRoot(userId: string): string {
	// userId 来自 JWT sub，非用户输入；仍做一层字符白名单防路径注入
	if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new AppError("BAD_REQUEST", "用户标识不合法");
	return join(env.dataDir, "users", userId);
}

/** per-user pi agentDir（auth.json / models.json 物理隔离） */
export function userAgentDir(userId: string): string {
	const dir = join(userRoot(userId), "agent");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** per-user 会话 JSONL 目录 */
export function userSessionsDir(userId: string): string {
	const dir = join(userRoot(userId), "sessions");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** per-user 会话运行时元数据 sidecar（runMode 等，跨重启恢复） */
export function userSessionMetaPath(userId: string, sessionId: string): string {
	return join(userSessionsDir(userId), `${sessionId}.meta.json`);
}

export interface SessionMeta {
	runMode?: import("@pi-agent/common").RunMode;
}

export function readSessionMeta(userId: string, sessionId: string): SessionMeta {
	try {
		return JSON.parse(readFileSync(userSessionMetaPath(userId, sessionId), "utf8")) as SessionMeta;
	} catch {
		return {};
	}
}

export function writeSessionMeta(userId: string, sessionId: string, meta: SessionMeta): void {
	writeFileSync(
		userSessionMetaPath(userId, sessionId),
		`${JSON.stringify(meta, null, 2)}\n`,
		"utf8",
	);
}

/** 校验文件在 base 内，返回绝对路径；不存在的文件仍检查其父目录的链接。 */
export function insidePath(base: string, rel: string): string {
	const full = resolve(base, rel.replace(/\\/g, "/"));
	try {
		if (containsPath(base, full) && containsPath(resolveRealPath(base), resolveRealPath(full)))
			return full;
	} catch {
		// 无法确认物理路径安全时拒绝访问。
	}
	throw new AppError("BAD_REQUEST", "路径越界");
}

/** 用相对路径判断归属，避免同名前缀和不同盘符绕过。 */
export function containsPath(base: string, path: string): boolean {
	const rel = relative(resolve(base), resolve(path));
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** 不存在的路径沿最近存在的父目录解析；断链和权限错误直接拒绝。 */
export function resolveRealPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			lstatSync(absolute);
		} catch (statError) {
			if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
			const parent = dirname(absolute);
			if (parent === absolute) throw error;
			return join(resolveRealPath(parent), basename(absolute));
		}
		throw error;
	}
}
