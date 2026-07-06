-- ROLE-2 (standing-role.md §3/§8): a Standing Role's CONCERNS + per-role rails.
--
-- Bind triggers to a role's concerns so a firing WAKES the role → spawns its loop
-- (ROLE-1 shipped the record + manual wake). This migration is ADDITIVE only:
--
--   * `concerns` — jsonb array of { id, repoPath, trigger:{type,filter}, focus,
--     enabled?, triggerId? }. WHAT the role watches + WHERE + the wake focus. Each
--     concern's runtime footprint is a BACKING trigger row whose `config.roleConcern`
--     names { roleId, concernId }; when that trigger fires the dispatch wakes the role.
--     Defaults to '[]' so every ROLE-1 row reads back as "no concerns" (byte-identical).
--
--   * `policy` — jsonb { budgetPerDay?, cascadeDepth? }. The per-role rails
--     (loop-triggers.md §4): a daily budget + a concurrent-loop cascade ceiling so a
--     misfiring concern can't spawn unbounded loops. NULL ⇒ server default constants.
--     `enabled` (unchanged) stays the role's primary kill-switch.
--
-- A role is a DEFINITION not a process (§6): no new runtime is added — the concern's
-- backing trigger rides the EXISTING file-watcher / github poller.
ALTER TABLE "standing_roles"
  ADD COLUMN IF NOT EXISTS "concerns" jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE "standing_roles"
  ADD COLUMN IF NOT EXISTS "policy" jsonb;
