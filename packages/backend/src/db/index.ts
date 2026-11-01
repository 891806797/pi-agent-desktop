import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

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
