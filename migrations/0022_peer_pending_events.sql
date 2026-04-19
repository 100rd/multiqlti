-- Peer pending events queue (issue #322)
-- Per-peer offline queue for config-sync events with TTL and coalesce support.
--
-- Behaviour:
--   • When a send to a peer fails (peer offline) a row is inserted here.
--   • On reconnect the queue is flushed in enqueued_at ASC order.
--   • Coalesce: only the latest event per (peer_id, entity_kind, entity_id)
--     is retained — older rows are deleted before inserting a replacement.
--   • TTL: rows older than the configured threshold (default 7 days) are
--     pruned; the peer receives a "requires full resync" signal instead.
--   • Circuit breaker: when queue depth per peer exceeds the configured limit
--     the peer is temporarily suspended and an alert is raised.

CREATE TYPE peer_pending_status AS ENUM ('pending', 'sending', 'sent', 'expired');

CREATE TABLE IF NOT EXISTS "peer_pending_events" (
  "peer_id"        text                    NOT NULL,
  "event_id"       varchar                 NOT NULL
                     REFERENCES "config_events_outbox" ("id") ON DELETE CASCADE,
  "enqueued_at"    timestamp               NOT NULL DEFAULT now(),
  "last_retry_at"  timestamp,
  "retry_count"    integer                 NOT NULL DEFAULT 0,
  "status"         peer_pending_status     NOT NULL DEFAULT 'pending',
  PRIMARY KEY ("peer_id", "event_id")
);

-- Index for flushing: fetch pending events for a peer ordered by enqueue time.
CREATE INDEX IF NOT EXISTS "peer_pending_events_flush_idx"
  ON "peer_pending_events" ("peer_id", "enqueued_at")
  WHERE "status" = 'pending';

-- Index for TTL scan: find old pending events across all peers.
CREATE INDEX IF NOT EXISTS "peer_pending_events_ttl_idx"
  ON "peer_pending_events" ("enqueued_at")
  WHERE "status" = 'pending';

-- Index for coalesce: look up existing pending event by entity.
-- Requires joining with config_events_outbox to reach entity_kind / entity_id;
-- the outbox already has config_events_outbox_entity_idx for that join.
CREATE INDEX IF NOT EXISTS "peer_pending_events_peer_idx"
  ON "peer_pending_events" ("peer_id")
  WHERE "status" = 'pending';
