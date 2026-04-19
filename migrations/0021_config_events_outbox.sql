-- Config sync federation event outbox (issue #321)
-- Transactional outbox for broadcasting config mutations to federated peers.
-- Publisher loop reads unsent rows and marks sent_at on success.
-- Subscriber deduplication: unique (peer_id, entity_kind, entity_id, version).

CREATE TABLE IF NOT EXISTS "config_events_outbox" (
  "id"           varchar   PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_kind"  text      NOT NULL,
  "entity_id"    text      NOT NULL,
  "operation"    text      NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  "payload_jsonb" jsonb    NOT NULL DEFAULT '{}'::jsonb,
  "created_at"   timestamp NOT NULL DEFAULT now(),
  "sent_at"      timestamp
);

CREATE INDEX IF NOT EXISTS "config_events_outbox_unsent_idx"
  ON "config_events_outbox" ("created_at")
  WHERE "sent_at" IS NULL;

CREATE INDEX IF NOT EXISTS "config_events_outbox_entity_idx"
  ON "config_events_outbox" ("entity_kind", "entity_id");

-- Idempotency table: tracks events received from remote peers.
-- Prevents re-applying the same event more than once.
CREATE TABLE IF NOT EXISTS "config_events_received" (
  "peer_id"      text      NOT NULL,
  "entity_kind"  text      NOT NULL,
  "entity_id"    text      NOT NULL,
  "version"      text      NOT NULL,
  "received_at"  timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("peer_id", "entity_kind", "entity_id", "version")
);
