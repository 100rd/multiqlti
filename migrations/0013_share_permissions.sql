-- Migration: Fine-grained sharing permissions (issue #232)
-- Adds role-based access control columns to shared_sessions table.
-- Backward compatible: all defaults match existing "collaborator" behavior.

ALTER TABLE shared_sessions
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'collaborator',
  ADD COLUMN IF NOT EXISTS allowed_stages jsonb,
  ADD COLUMN IF NOT EXISTS can_chat boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_vote boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_view_memories boolean NOT NULL DEFAULT true;
