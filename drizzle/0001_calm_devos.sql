CREATE TYPE "public"."comment_thread_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TABLE "document_comment_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_comment_messages_body_length_check" CHECK (char_length("document_comment_messages"."body") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "document_comment_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"start_item_id" text NOT NULL,
	"start_side" text NOT NULL,
	"end_item_id" text NOT NULL,
	"end_side" text NOT NULL,
	"quoted_text" text NOT NULL,
	"status" "comment_thread_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_comment_threads_start_side_check" CHECK ("document_comment_threads"."start_side" IN ('before', 'after')),
	CONSTRAINT "document_comment_threads_end_side_check" CHECK ("document_comment_threads"."end_side" IN ('before', 'after')),
	CONSTRAINT "document_comment_threads_quote_length_check" CHECK (char_length("document_comment_threads"."quoted_text") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "document_comment_messages" ADD CONSTRAINT "document_comment_messages_thread_id_document_comment_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."document_comment_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comment_messages" ADD CONSTRAINT "document_comment_messages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comment_threads" ADD CONSTRAINT "document_comment_threads_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comment_threads" ADD CONSTRAINT "document_comment_threads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_comment_messages_thread_created_idx" ON "document_comment_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "document_comment_threads_document_created_idx" ON "document_comment_threads" USING btree ("document_id","created_at");