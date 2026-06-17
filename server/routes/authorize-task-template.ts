/**
 * Owner-or-admin authorization for a TASK TEMPLATE (library recipe), keyed on
 * `task_templates.createdBy` (same posture as task_groups — templates are
 * owner-scoped standalone resources).
 *
 * Mirrors routes/authorize-task-group.ts BYTE-FOR-BYTE (MF-4):
 *   - ordering 401 unauth → 404 missing → 403 non-owner;
 *   - admin bypass;
 *   - STRICT: ownerless templates (createdBy == null) are DENIED to non-admins;
 *   - fail-closed via the shared `isVisible` predicate.
 *
 * On success returns { template, ownerId }; on failure it writes the status + a
 * generic body to `res` and returns null (the caller must early-return).
 *
 * Caller: server/routes/task-templates.ts (every per-id route) and the compose
 * helper's owner-check at compose time (server/services/task-template-compose.ts).
 */
import type { Request, Response } from "express";
import type { IStorage } from "../storage";
import type { TaskTemplateRow } from "@shared/schema";
import { isVisible } from "./authorize-run.js";

export interface AuthorizedTaskTemplate {
  /** The template row (already loaded — callers reuse it to avoid a second read). */
  template: TaskTemplateRow;
  /** The template owner id (task_templates.createdBy); null for ownerless (admin-only). */
  ownerId: string | null;
}

export async function authorizeTaskTemplate(
  req: Request,
  res: Response,
  storage: IStorage,
  templateId: string,
): Promise<AuthorizedTaskTemplate | null> {
  // 401 first — unauth takes precedence over existence.
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  const template = await storage.getTaskTemplate(templateId);
  if (!template) {
    res.status(404).json({ error: "Task template not found" });
    return null;
  }

  // Reuse the shared predicate; 403 when not visible (owner mismatch / ownerless / non-admin).
  if (!isVisible(template.createdBy, req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  return { template, ownerId: template.createdBy };
}
