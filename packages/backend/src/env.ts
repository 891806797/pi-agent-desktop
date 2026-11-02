/**
 * 环境配置单源 —— 所有可配置项集中于此，其余模块只从这里读。
 * Web 开发由 Bun 加载 .env；桌面 sidecar 仅使用宿主传入的环境变量。
 */

import { resolve } from "node:path";

const desktopToken = Bun.env.PI_DESKTOP_TOKEN;
// 连接凭据只属于宿主边界，不能由后续启动的工具进程继承。
delete Bun.env.PI_DESKTOP_TOKEN;

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
	desktopToken,
	port: desktopToken !== undefined ? 0 : num("PORT", 3333),
	host: desktopToken !== undefined ? "127.0.0.1" : str("HOST", "0.0.0.0"),
	/** 数据根目录（用户表、per-user agent 配置与会话 JSONL） */
	dataDir: resolve(str("DATA_DIR", "./data")),
	/** JWT 密钥；未配置时由认证模块在 SQLite 中自举持久化。 */
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
