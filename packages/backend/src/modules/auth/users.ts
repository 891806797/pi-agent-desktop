/**
 * 用户表 —— data/users.json + Bun.password（bcrypt）。
 * 首启动无文件时 seed admin（admin/admin123，登录后改密），够单机多人场景，不引 DB（YAGNI）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/env";
import type { AuthUser } from "./token";

export interface UserRecord {
	id: string;
	username: string;
	/** Bun.password bcrypt hash */
	passwordHash: string;
	createdAt: string;
}

const USERS_FILE = () => join(env.dataDir, "users.json");

let users: UserRecord[] | null = null;

function load(): UserRecord[] {
	if (users !== null) return users;
	if (existsSync(USERS_FILE())) {
		try {
			users = JSON.parse(readFileSync(USERS_FILE(), "utf8")) as UserRecord[];
			return users;
		} catch {
			// 损坏则视为空表重建（密码表损坏不该阻断启动）
		}
	}
	users = [];
	return users;
}

function persist(): void {
	mkdirSync(env.dataDir, { recursive: true });
	writeFileSync(USERS_FILE(), `${JSON.stringify(load(), null, 2)}\n`, "utf8");
}

/** 首启动 seed admin */
export function ensureSeed(): void {
	const all = load();
	if (all.length === 0) {
		all.push({
			id: crypto.randomUUID(),
			username: "admin",
			passwordHash: Bun.password.hashSync("admin123"),
			createdAt: new Date().toISOString(),
		});
		persist();
		console.log("[users] 首启动 seed admin/admin123，请登录后修改密码");
	}
}

export async function authenticate(username: string, password: string): Promise<AuthUser | null> {
	const rec = load().find((u) => u.username === username);
	if (!rec) return null;
	const valid = await Bun.password.verify(password, rec.passwordHash);
	return valid ? { userId: rec.id, username: rec.username } : null;
}

/** 启动恢复只读取身份，不向 agent 模块提供密码记录。 */
export function listAuthUsers(): AuthUser[] {
	return load().map(({ id, username }) => ({ userId: id, username }));
}
