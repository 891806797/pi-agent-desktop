import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessionRuntime = sqliteTable(
	"session_runtime",
	{
		userId: text("user_id").notNull(),
		sessionId: text("session_id").notNull(),
		state: text("state").notNull(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);

export const sessionSettings = sqliteTable(
	"session_settings",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: text("user_id").notNull(),
		sessionId: text("session_id").notNull(),
		settings: text("settings").notNull(),
	},
	(table) => [uniqueIndex("session_settings_owner_session").on(table.userId, table.sessionId)],
);

export const userSettings = sqliteTable("user_settings", {
	userId: text("user_id").primaryKey(),
	settings: text("settings").notNull(),
});
export const userWorkspaces = sqliteTable(
	"user_workspaces",
	{
		userId: text("user_id").notNull(),
		workspace: text("workspace").notNull(),
		position: integer("position").notNull(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.workspace] })],
);
export const appMetadata = sqliteTable("app_metadata", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
});

export const users = sqliteTable("users", {
	id: text("id").primaryKey(),
	username: text("username").notNull().unique(),
	passwordHash: text("password_hash").notNull(),
	createdAt: text("created_at").notNull(),
});

export const sessionCatalog = sqliteTable(
	"session_catalog",
	{
		userId: text("user_id").notNull(),
		sessionId: text("session_id").notNull(),
		workspace: text("workspace").notNull(),
		name: text("name"),
		firstMessage: text("first_message").notNull().default(""),
		hasHistory: integer("has_history", { mode: "boolean" }).notNull().default(false),
		managementError: text("management_error"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		archivedAt: integer("archived_at"),
		lifecycle: text("lifecycle", { enum: ["normal", "deleting", "deleted"] })
			.notNull()
			.default("normal"),
		revision: integer("revision").notNull().default(1),
		noticeVersion: integer("notice_version").notNull().default(0),
		readVersion: integer("read_version").notNull().default(0),
		noticeKind: text("notice_kind", { enum: ["attention", "completed", "failed", "notification"] }),
	},
	(table) => [primaryKey({ columns: [table.userId, table.sessionId] })],
);

export const userCatalogState = sqliteTable("user_catalog_state", {
	userId: text("user_id").primaryKey(),
	listVersion: integer("list_version").notNull().default(0),
});

export const sessionActions = sqliteTable(
	"session_actions",
	{
		userId: text("user_id").notNull(),
		actionId: text("action_id").notNull(),
		sessionId: text("session_id").notNull(),
		state: text("state").notNull(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.actionId] })],
);
