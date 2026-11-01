CREATE TABLE `session_runtime` (
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`user_id`, `session_id`)
);
