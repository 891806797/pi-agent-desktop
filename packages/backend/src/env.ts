/**
 * 环境配置单源 —— 所有可配置项集中于此，其余模块只从这里读。
 * Bun 自动加载 cwd 下 .env 进 Bun.env，生产（编译版）可用 exe 同目录 .env 覆盖。
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// JWT_SECRET 自举：未配置时随机生成并写回 .env（Bun 自动加载，首启动即稳定）
if (!Bun.env.JWT_SECRET) {
	const generated = crypto.randomUUID();
	const line = `JWT_SECRET=${generated}\n`;
	if (existsSync(".env")) {
		const prev = readFileSync(".env", "utf8");
		writeFileSync(".env", `${prev}${line}`, "utf8");
	} else {
		appendFileSync(".env", line, "utf8");
	}
	Bun.env.JWT_SECRET = generated;
}

function num(key: string, def: number): number {
	const v = Bun.env[key];
	if (v === undefined || v === "") return def;
	const n = Number(v);
	return Number.isFinite(n) ? n : def;
}

function str(key: string, def: string): string {
	const v = Bun.env[key];
	return v === undefined || v === "" ? def : v;
}

export const env = {
	port: num("PORT", 3333),
	host: str("HOST", "0.0.0.0"),
	/** 数据根目录（用户表、per-user agent 配置与会话 JSONL） */
	dataDir: resolve(str("DATA_DIR", "./data")),
	/** JWT 密钥；未配置时首启动随机生成并写回 .env（单机部署自洽） */
	jwtSecret: str("JWT_SECRET", ""),
	tokenTtlSec: num("TOKEN_TTL_SEC", 7 * 24 * 3600),
	/** 工作空间根白名单：会话 cwd 必须位于其中之一（逗号分隔） */
	workspaceRoots: str("WORKSPACE_ROOTS", "")
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean),
	/** 配额 */
	maxSessionsPerUser: num("MAX_SESSIONS_PER_USER", 3),
	maxSessionsTotal: num("MAX_SESSIONS_TOTAL", 24),
	/** 会话空闲回收（分钟） */
	idleGcMinutes: num("IDLE_GC_MINUTES", 30),
	janitorIntervalSec: num("JANITOR_INTERVAL_SEC", 60),
	/** SSE 心跳间隔（秒）与看门狗阈值（秒，前端 >2 心跳周期无帧重开）。
	 *  心跳须 < Bun.serve idleTimeout（240s），否则空闲连接会被服务端先关 */
	sseHeartbeatSec: num("SSE_HEARTBEAT_SEC", 5),
} as const;

export type Env = typeof env;
