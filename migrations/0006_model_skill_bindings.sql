-- Phase 6.17 — Per-model skill assignment
-- Creates model_skill_bindings table linking LLM model IDs to skills.

CREATE TABLE IF NOT EXISTS "model_skill_bindings" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "model_id" text NOT NULL,
  "skill_id" varchar NOT NULL REFERENCES "skills"("id") ON DELETE CASCADE,
  "created_by" text REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "model_skill_bindings_model_id_skill_id_unique" UNIQUE("model_id", "skill_id")
);

CREATE INDEX IF NOT EXISTS "model_skill_bindings_model_id_idx" ON "model_skill_bindings" ("model_id");
