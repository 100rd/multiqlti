-- Consult: standalone multi-model Q&A (workspace-independent). Additive/non-breaking.
-- A session holds a strategic question + the operator-selected model slugs; answers
-- accrue per model per round (0 = independent, 1+ = debate). On handoff the session
-- records the consilium loop + workspace it became. Ship-only: applied by the lead.
CREATE TABLE IF NOT EXISTS consult_sessions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  question text NOT NULL,
  model_slugs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'created',
  created_by text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  loop_id text,
  workspace_id text
);

CREATE TABLE IF NOT EXISTS consult_answers (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES consult_sessions(id) ON DELETE CASCADE,
  model_slug text NOT NULL,
  round integer NOT NULL DEFAULT 0,
  content text,
  error_message text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consult_answers_session_id_idx ON consult_answers (session_id);
