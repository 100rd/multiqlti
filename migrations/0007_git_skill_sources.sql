-- Migration: git_skill_sources table + skills source columns
-- Phase: Git Skill Sources (issue #161)

CREATE TABLE IF NOT EXISTS "git_skill_sources" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  "name" text NOT NULL,
  "repo_url" text NOT NULL,
  "branch" text NOT NULL DEFAULT 'main',
  "path" text NOT NULL DEFAULT '/',
  "sync_on_start" boolean NOT NULL DEFAULT false,
  "last_synced_at" timestamp,
  "last_error" text,
  "encrypted_pat" text,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Add source tracking columns to skills table
ALTER TABLE "skills"
  ADD COLUMN IF NOT EXISTS "source_type" text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "git_source_id" varchar REFERENCES "git_skill_sources"("id") ON DELETE SET NULL;

-- Index for efficient lookup of skills by git source
CREATE INDEX IF NOT EXISTS "skills_git_source_id_idx" ON "skills"("git_source_id");
