-- Enforce per-owner project name uniqueness (no two projects with the same
-- name under the same owner). Backstops the route-level 409 check against the
-- create-create race. Idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_id_name_unique
  ON projects (owner_id, name);
