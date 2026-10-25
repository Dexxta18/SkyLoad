CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"credentials" text NOT NULL,
	"access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"scope" text,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"torrent_file" text,
	"destination" jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"downloaded_bytes" bigint DEFAULT 0 NOT NULL,
	"uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"download_speed" integer DEFAULT 0 NOT NULL,
	"upload_speed" integer DEFAULT 0 NOT NULL,
	"peers" integer DEFAULT 0 NOT NULL,
	"note" text,
	"error" text,
	"result" jsonb,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"google_sub" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_provider_external" ON "accounts" USING btree ("user_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "jobs_user_created" ON "jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_created" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "jobs_user_updated" ON "jobs" USING btree ("user_id","updated_at");