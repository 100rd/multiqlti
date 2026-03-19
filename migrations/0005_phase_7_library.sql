-- Migration: Phase 7 — Library channels and items tables

CREATE TABLE IF NOT EXISTS library_channels (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_polled_at TIMESTAMP,
  error_message TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS library_items (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR REFERENCES library_channels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  url TEXT,
  content_text TEXT,
  summary TEXT,
  author TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_type TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  published_at TIMESTAMP,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS library_items_channel_id_idx ON library_items(channel_id);
CREATE INDEX IF NOT EXISTS library_items_external_id_idx ON library_items(external_id);
CREATE INDEX IF NOT EXISTS library_items_published_at_idx ON library_items(published_at);
