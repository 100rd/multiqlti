-- ROLE-1 (standing-role.md §3/§8): the StandingRole record.
--
-- A named, persistent identity (persona + skills + loop template) an operator can
-- manually "wake" (POST /api/roles/:id/wake) to spawn ONE ephemeral consilium loop.
-- ROLE-1 is JUST the record + manual wake — NO triggers/concerns (ROLE-2), NO
-- role-scoped experience (ROLE-3). A role is a definition, not a running process (§6).
--
-- Project-scoped (owner/member isolation via the app's withProject helper), cascades
-- with the owning project. `skills` = skill ids validated against the project's skill
-- registry. `loop_template` = { preset, maxRounds?, reviewMode? } (server enums).
CREATE TABLE IF NOT EXISTS "standing_roles" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" text,
  "name" text NOT NULL,
  "persona" text NOT NULL,
  "skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "loop_template" jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "standing_roles"
    ADD CONSTRAINT "standing_roles_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "standing_roles"
    ADD CONSTRAINT "standing_roles_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "standing_roles_project_id_idx" ON "standing_roles" ("project_id");
CREATE INDEX IF NOT EXISTS "standing_roles_created_by_idx" ON "standing_roles" ("created_by");
