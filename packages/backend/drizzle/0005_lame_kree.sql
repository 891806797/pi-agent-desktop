CREATE TABLE `app_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_workspaces` (
	`user_id` text NOT NULL,
	`workspace` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`user_id`, `workspace`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`settings` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_session_settings`("user_id", "session_id", "settings") SELECT "user_id", "session_id", "settings" FROM `session_settings`;--> statement-breakpoint
DROP TABLE `session_settings`;--> statement-breakpoint
ALTER TABLE `__new_session_settings` RENAME TO `session_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `session_settings_owner_session` ON `session_settings` (`user_id`,`session_id`);
