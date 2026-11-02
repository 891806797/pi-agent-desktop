import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { env } from "@/env";
import * as schema from "./schema";

/** 配置读写短事务不保留额外连接，避免测试切数据目录或热重载残留句柄。 */
export function withRuntimeDatabase<T>(
	action: (db: ReturnType<typeof openRuntimeDatabase>) => T,
): T {
	const db = openRuntimeDatabase(join(env.dataDir, "runtime.sqlite"));
	try {
		return action(db);
	} finally {
		db.$client.close(true);
	}
}

export function openRuntimeDatabase(file: string) {
	mkdirSync(dirname(file), { recursive: true });
	const client = new Database(file, { create: true });
	try {
		client.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
		const db = drizzle(client, { schema });
		// 单文件编译版把整个 drizzle 目录嵌入 bunfs，使用同一套官方迁移器。
		const embedded = join(import.meta.dir, "drizzle");
		migrate(db, {
			migrationsFolder: existsSync(join(embedded, "meta/_journal.json"))
				? embedded
				: join(import.meta.dir, "../../drizzle"),
		});
		return db;
	} catch (error) {
		client.close(true);
		throw error;
	}
}
