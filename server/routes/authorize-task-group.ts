/**
 * Owner-or-admin authorization for a TASK GROUP, keyed on `task_groups.createdBy`
 * (NOT `pipeline_runs.triggeredBy` — task groups have no pipeline_runs row).
 *
 * Mirrors routes/authorize-run.ts exactly:
 *   - ordering 401 unauth → 404 missing → 403 non-owner;
 *   - admin bypass;
 *   - STRICT: ownerless groups (createdBy == null) are DENIED to non-admins.
 *
 * On success returns { group, ownerId }; on failure it writes the status + a
 * generic body to `res` and returns null (the caller must early-return).
 *
 * Closes the pre-existing IDOR on every task-group route (C1): the routes were
 * behind requireAuth but performed NO ownership check.
 *
 * Caller: server/routes/task-groups.ts (every per-id route + the 4 edit routes).
 */
import type { Request, Response } from "express";
import type { IStorage } from "../storage";
import type { TaskGroupRow } from "@shared/schema";
import { isVisible } from "./authorize-run.js";

export interface AuthorizedTaskGroup {
  /** The group row (already loaded — callers reuse it to avoid a second read). */
  group: TaskGroupRow;
  /** The group owner id (task_groups.createdBy); null for ownerless groups (admin-only). */
  ownerId: string | null;
}

export async function authorizeTaskGroup(
  req: Request,
  res: Response,
  storage: IStorage,
  groupId: string,
): Promise<AuthorizedTaskGroup | null> {
  // 401 first — unauth takes precedence over existence.
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  const group = await storage.getTaskGroup(groupId);
  if (!group) {
    res.status(404).json({ error: "Task group not found" });
    return null;
  }

  // Reuse the shared predicate; 403 when not visible (owner mismatch / ownerless / non-admin).
  if (!isVisible(group.createdBy, req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  return { group, ownerId: group.createdBy };
}
