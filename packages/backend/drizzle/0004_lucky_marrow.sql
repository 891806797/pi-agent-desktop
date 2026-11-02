CREATE TABLE `session_settings` (
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`settings` text NOT NULL,
	PRIMARY KEY(`user_id`, `session_id`)
);
