-- Phase 3b (ADR-003 §D3, additive/non-breaking): how a secret's `value_encrypted`
-- is interpreted at exec-time delivery. "static" (a raw string keyed by name; the
-- default and today's behavior), "aws" (JSON creds → AWS_* env), "kubernetes"
-- (kubeconfig → per-run 0600 temp file + KUBECONFIG). Existing rows default to
-- "static" ⇒ byte-identical. Ship-only: applied by the lead, not by this change.
ALTER TABLE secrets
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'static';
