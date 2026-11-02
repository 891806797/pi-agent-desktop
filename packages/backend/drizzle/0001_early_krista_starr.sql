CREATE TABLE `session_actions` (
	`user_id` text NOT NULL,
	`action_id` text NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`user_id`, `action_id`)
);
--> statement-breakpoint
CREATE TABLE `session_catalog` (
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`workspace` text NOT NULL,
	`name` text,
	`first_message` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` integer,
	`lifecycle` text DEFAULT 'normal' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`notice_version` integer DEFAULT 0 NOT NULL,
	`read_version` integer DEFAULT 0 NOT NULL,
	`notice_kind` text,
	PRIMARY KEY(`user_id`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `user_catalog_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`list_version` integer DEFAULT 0 NOT NULL
);
