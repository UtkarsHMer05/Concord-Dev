CREATE TYPE "public"."suggestion_status" AS ENUM('proposed', 'accepted', 'rejected', 'discharged');--> statement-breakpoint
CREATE TABLE "document_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"start_item_id" text NOT NULL,
	"start_side" text NOT NULL,
	"end_item_id" text NOT NULL,
	"end_side" text NOT NULL,
	"quoted_text" text NOT NULL,
	"proposed_text" text NOT NULL,
	"status" "suggestion_status" DEFAULT 'proposed' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_suggestions_start_side_check" CHECK ("document_suggestions"."start_side" IN ('before', 'after')),
	CONSTRAINT "document_suggestions_end_side_check" CHECK ("document_suggestions"."end_side" IN ('before', 'after')),
	CONSTRAINT "document_suggestions_quote_length_check" CHECK (char_length("document_suggestions"."quoted_text") <= 1000),
	CONSTRAINT "document_suggestions_proposed_length_check" CHECK (char_length("document_suggestions"."proposed_text") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_suggestions_document_created_idx" ON "document_suggestions" USING btree ("document_id","created_at");