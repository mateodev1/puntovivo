ALTER TABLE `users` ADD `pin_failed_attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE users SET staff_pin_hash = NULL;
