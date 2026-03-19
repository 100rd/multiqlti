CREATE TABLE IF NOT EXISTS "skill_teams" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);
