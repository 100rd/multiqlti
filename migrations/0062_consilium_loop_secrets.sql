-- Phase 3a (ADR-003 §D2, additive/non-breaking): the named secrets a consilium loop
-- is ALLOWED to use. Binding a secret to a loop at creation is the operator's explicit
-- approval; the Phase-3 broker (`issueLease`) refuses any credential not in this bound
-- set. Metadata only — the secret VALUE never lives here (it stays encrypted in
-- `secrets.valueEncrypted`, read solely through the broker's sanctioned decrypt path).
-- Ship-only: applied by the lead, not by this change.
CREATE TABLE IF NOT EXISTS consilium_loop_secrets (
  loop_id varchar NOT NULL REFERENCES consilium_loops(id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  created_by text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT consilium_loop_secrets_pk PRIMARY KEY (loop_id, credential_id)
);
CREATE INDEX IF NOT EXISTS consilium_loop_secrets_loop_id_idx ON consilium_loop_secrets (loop_id);
