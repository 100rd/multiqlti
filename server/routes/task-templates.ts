/**
 * Task Groups v2 — Task Library (template) routes (BE7, §5.2).
 *
 * Owner-scoped CRUD over `task_templates`. Per-id routes are gated by
 * `authorizeTaskTemplate` (401→404→403, admin bypass, ownerless-denied — the
 * byte-for-byte mirror of `authorize-task-group.ts`).
 *
 * LIST (MF-4): the ownership filter is applied BEFORE/WITH the `?label=` match
 * (`getTaskTemplates({ownerId, isAdmin, label})`) so a non-admin can never
 * enumerate another tenant's templates by label. `created_by` is STRIPPED for
 * non-admins (mirrors the task-groups list at `task-groups.ts:104`).
 *
 * SF-2: `?label=` is Zod-validated as a bounded string; the storage layer passes
 * it as a bind param to the PG `jsonb` containment operator (never interpolated).
 *
 * Cursor is an opaque base64url keyset over `created_at desc, id desc`, mirroring
 * the `activity.ts` CursorSchema idiom; limit is clamped to <= 100.
 *
 * Caller: server/routes.ts (registerTaskTemplateRoutes).
 */
import { Router } from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import type { IStorage } from "../storage";
import type { TaskTemplateRow } from "@shared/schema";
import { insertTaskTemplateSchema } from "@shared/schema";
import { validateBody } from "../middleware/validate.js";
import { authorizeTaskTemplate } from "./authorize-task-template.js";
import { TASK_GROUP_V2_MAX_LIMIT } from "../storage-task-groups-v2.js";

// ─── Cursor (opaque base64url keyset, Zod-validated) ────────────────────────

const CursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().min(1).max(200),
});
type Cursor = z.infer<typeof CursorSchema>;

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** Parse an opaque cursor; returns null on any malformed/invalid input. */
function decodeCursor(raw: string): Cursor | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = CursorSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// SF-2: bound the label query (string only; bounded length) so it cannot become
// an unbounded scan vector. The storage layer parameterizes it.
const ListQuerySchema = z.object({
  label: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(TASK_GROUP_V2_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(2000).optional(),
});

/** PATCH — every template field optional; at least one required (≥1). */
const UpdateTemplateSchema = insertTaskTemplateSchema
  .omit({ createdBy: true })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: "At least one field is required" });

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generic error envelope — never leak String(err) (M1 posture). */
function sendError(res: Response, _err: unknown, fallbackMessage: string): void {
  res.status(500).json({ error: fallbackMessage });
}

/** Strip `created_by` for non-admins (mirror task-groups list at :104). */
function publicView(row: TaskTemplateRow, isAdmin: boolean): Record<string, unknown> {
  const view: Record<string, unknown> = { ...row };
  if (!isAdmin) delete view.createdBy;
  return view;
}

// ─── Route registration ─────────────────────────────────────────────────────

export function registerTaskTemplateRoutes(router: Router, storage: IStorage): void {
  // LIST — own-filtered (MF-4 owner-before-label), keyset-paginated, created_by stripped.
  router.get("/api/task-templates", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query" });

    const isAdmin = req.user.role === "admin";
    const limit = Math.min(parsed.data.limit ?? TASK_GROUP_V2_MAX_LIMIT, TASK_GROUP_V2_MAX_LIMIT);
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) return res.status(400).json({ error: "Invalid cursor" });

    try {
      // MF-4: owner filter is applied WITH the label match in storage; a non-admin
      // can never enumerate another owner's templates by label.
      const rows = await storage.getTaskTemplates({
        ownerId: req.user.id,
        isAdmin,
        label: parsed.data.label,
        limit,
        cursor: cursor ?? undefined,
      });
      const items = rows.map((row) => publicView(row, isAdmin));
      const last = rows[rows.length - 1];
      const nextCursor =
        rows.length === limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null;
      return res.json({ items, nextCursor });
    } catch {
      return res.status(500).json({ error: "Failed to load task templates" });
    }
  });

  // CREATE — stamps created_by from the session.
  router.post(
    "/api/task-templates",
    validateBody(insertTaskTemplateSchema),
    async (req: Request, res: Response) => {
      if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
      try {
        const body = req.body as z.infer<typeof insertTaskTemplateSchema>;
        const created = await storage.createTaskTemplate({ ...body, createdBy: req.user.id });
        return res.status(201).json(created);
      } catch (err) {
        return sendError(res, err, "Failed to create task template");
      }
    },
  );

  // GET one — owner-gated.
  router.get("/api/task-templates/:id", async (req: Request, res: Response) => {
    const auth = await authorizeTaskTemplate(req, res, storage, String(req.params.id));
    if (!auth) return;
    return res.json(auth.template);
  });

  // PATCH — owner-gated; partial (≥1 field); bumps updated_at via storage.
  router.patch(
    "/api/task-templates/:id",
    validateBody(UpdateTemplateSchema),
    async (req: Request, res: Response) => {
      const auth = await authorizeTaskTemplate(req, res, storage, String(req.params.id));
      if (!auth) return;
      try {
        const patch = req.body as Partial<TaskTemplateRow>;
        const updated = await storage.updateTaskTemplate(auth.template.id, patch);
        return res.json(updated);
      } catch (err) {
        return sendError(res, err, "Failed to update task template");
      }
    },
  );

  // DELETE — owner-gated; 204. Copied-in definitions survive (template_id set-null).
  router.delete("/api/task-templates/:id", async (req: Request, res: Response) => {
    const auth = await authorizeTaskTemplate(req, res, storage, String(req.params.id));
    if (!auth) return;
    try {
      await storage.deleteTaskTemplate(auth.template.id);
      return res.status(204).end();
    } catch (err) {
      return sendError(res, err, "Failed to delete task template");
    }
  });
}
