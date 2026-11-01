import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionRuntime = sqliteTable(
	"session_runtime",
	{
		userId: text("user_id").notNull(),
		sessionId: text("session_id").notNull(),
		state: text("state").notNull(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);
