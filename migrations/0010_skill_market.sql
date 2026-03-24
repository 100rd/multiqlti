CREATE TABLE "skill_registry_sources" (
  "id" serial PRIMARY KEY NOT NULL,
  "adapter_id" text UNIQUE NOT NULL,
  "name" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "config" jsonb,
  "last_sync_at" timestamp,
  "last_health_check_at" timestamp,
  "health_status" text NOT NULL DEFAULT 'unknown',
  "health_error" text,
  "catalog_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "skill_install_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "skill_id" varchar,
  "external_source" text,
  "external_id" text,
  "action" text NOT NULL,
  "from_version" text,
  "to_version" text,
  "user_id" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "external_source" text;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "external_id" text;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "external_version" text;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "installed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "auto_update" boolean DEFAULT false;
