ALTER TABLE "chat" ADD COLUMN "pending_user_message" text;--> statement-breakpoint
ALTER TABLE "chat" ADD COLUMN "pending_user_message_created_at" timestamp;