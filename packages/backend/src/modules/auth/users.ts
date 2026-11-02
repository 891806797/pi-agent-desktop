/** 用户身份存 SQLite；首次登录注册，已有账号仅验证密码。 */
import { eq } from "drizzle-orm";
import { withRuntimeDatabase } from "@/db";
import { users } from "@/db/schema";
import type { AuthUser } from "./token";

export function ensureSeed(): void {
	withRuntimeDatabase((db) =>
		db.transaction(() => {
			if (db.select().from(users).limit(1).get()) return;
			db.insert(users)
				.values({
					id: crypto.randomUUID(),
					username: "admin",
					passwordHash: Bun.password.hashSync("admin123"),
					createdAt: new Date().toISOString(),
				})
				.run();
		}),
	);
}
export async function authenticate(username: string, password: string): Promise<AuthUser | null> {
	let record = withRuntimeDatabase((db) =>
		db.select().from(users).where(eq(users.username, username)).get(),
	);
	if (!record) {
		const passwordHash = await Bun.password.hash(password);
		record = withRuntimeDatabase((db) =>
			db.transaction(() => {
				const existing = db.select().from(users).where(eq(users.username, username)).get();
				if (existing) return existing;
				const created = {
					id: crypto.randomUUID(),
					username,
					passwordHash,
					createdAt: new Date().toISOString(),
				};
				db.insert(users).values(created).run();
				return created;
			}),
		);
	}
	return (await Bun.password.verify(password, record.passwordHash))
		? { userId: record.id, username: record.username }
		: null;
}
/** 启动恢复只暴露身份，不向 agent 提供密码哈希。 */
export function listAuthUsers(): AuthUser[] {
	return withRuntimeDatabase((db) =>
		db.select({ userId: users.id, username: users.username }).from(users).all(),
	);
}
