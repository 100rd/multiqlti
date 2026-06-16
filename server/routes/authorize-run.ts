/**
 * Shared run-authorization helper (extracted from the byte-identical inline
 * copies that lived in routes/orchestrator.ts and routes/consensus.ts).
 *
 * Resolves owner-or-admin access for a run keyed by pipeline_runs.id — the
 * single source of ownership for ALL run modes (orchestrator/consensus/manager
 * runs all FK their runId to pipeline_runs.id, so triggeredBy is authoritative).
 *
 * Ordering (preserved exactly): 401 unauth → 404 missing → 403 non-owner.
 * STRICTER than the manager idiom: triggeredBy == null is DENIED unless admin
 * (transcripts/activity are never world-readable).
 *
 * On success returns { ownerId }; on failure it writes the status + a generic
 * body to `res` and returns null (the caller must early-return).
 *
 * Callers: routes/orchestrator.ts, routes/consensus.ts, routes/activity.ts,
 * routes/authorize-task-group.ts (via isVisible), ws/manager.ts (via isVisible).
 */
import type { Request, Response } from "express";
import type { IStorage } from "../storage";

/** Minimal user shape the visibility predicate needs (id + role). */
export interface VisibilityUser {
  id?: string;
  role?: string;
}

/**
 * The single ownership-visibility predicate shared by every owner-scoped read in
 * the codebase (authorizeRun, authorizeTaskGroup, the activity history filter,
 * and the WS subscribe gate). A row is visible iff the caller is an admin OR the
 * caller owns it. Ownerless rows (ownerId == null) are visible ONLY to admins —
 * the STRICT posture (transcripts/activity/groups are never world-readable).
 *
 * Fail-closed: a caller with no id is never granted visibility.
 */
export function isVisible(
  ownerId: string | null | undefined,
  user: VisibilityUser | undefined,
): boolean {
  if (!user?.id) return false;
  if (user.role === "admin") return true;
  return ownerId != null && ownerId === user.id;
}

export interface AuthorizeRunOptions {
  /**
   * Optional secondary existence check for mode-specific runs. When provided and
   * it resolves to a falsy value, the result is 404 (mirrors the prior inline
   * `if (!run || !orch)` / `if (!run || !consensus)` behavior). Omit it for the
   * activity lens, which only needs the parent pipeline_runs row.
   */
  requireModeRow?: (storage: IStorage, runId: string) => Promise<unknown>;
}

export interface AuthorizedRun {
  /** The run's owner id (pipeline_runs.triggeredBy); null for ownerless runs (admin-only). */
  ownerId: string | null;
}

export async function authorizeRun(
  req: Request,
  res: Response,
  storage: IStorage,
  runId: string,
  options: AuthorizeRunOptions = {},
): Promise<AuthorizedRun | null> {
  // 401 first — unauth takes precedence over existence.
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  const run = await storage.getPipelineRun(runId);
  const modeRow = run && options.requireModeRow ? await options.requireModeRow(storage, runId) : true;
  if (!run || !modeRow) {
    res.status(404).json({ error: "Run not found" });
    return null;
  }

  // Reuse the shared predicate; 403 when not visible (owner mismatch / ownerless / non-admin).
  if (!isVisible(run.triggeredBy, req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  return { ownerId: run.triggeredBy };
}
