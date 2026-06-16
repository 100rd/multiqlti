/**
 * Task Groups v2 — iteration routes (BE6).
 *
 * Every route is gated by `authorizeTaskGroup(:id)` (401→404→403, admin bypass,
 * ownerless-denied). On top of that gate:
 *
 *   - LIST is a metadata-only ALLOWLIST (MF-2): IterationSummary is built by an
 *     explicit field map — NEVER a `...spread` — so `iteration.input` (the user
 *     prompt snapshot) and `iteration.output` (run summaries) can never leak.
 *     `triggeredBy` is ADMIN-ONLY. Falls back to the lazy virtual-iteration
 *     adapter for pre-v2 groups INSIDE the authorized handler (MF-5).
 *   - DETAIL (`:n`) is owner-gated and re-checks `iteration.group_id === :id`
 *     (cross-group → 404); executions are fetched group-scoped (MF-1) and DO
 *     expose summary/error/output/model_slug (owner-only).
 *   - TRACE (`:n/trace`) loads the iteration, asserts `group_id === :id`, then
 *     reads the trace scoped to that verified iteration (MF-3); 404 if none.
 *
 * Cursor is an opaque base64url keyset over `iteration_number desc`, mirroring
 * the `activity.ts` CursorSchema idiom; limit is clamped to <= 100.
 *
 * Caller: server/routes.ts (registerTaskIterationRoutes).
 */
import { Router } from "express";
import { z } from "zod";
import type { Request, Response } from "express";
import type { IStorage } from "../storage";
import type { TaskGroupIterationRow, TaskExecutionRow } from "@shared/schema";
import { authorizeTaskGroup } from "./authorize-task-group.js";
import { TASK_GROUP_V2_MAX_LIMIT } from "../storage-task-groups-v2.js";

// ─── Cursor (opaque base64url keyset, Zod-validated) ────────────────────────

const CursorSchema = z.object({
  iterationNumber: z.number().int().min(1),
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

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(TASK_GROUP_V2_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(2000).optional(),
});

// ─── Metadata-only summary (MF-2 ALLOWLIST) ─────────────────────────────────

interface IterationSummary {
  iterationNumber: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  completedCount: number;
  taskCount: number;
  /** ADMIN-ONLY. */
  triggeredBy?: string | null;
}

/** Compute durationMs from the iteration timestamps (null until both present). */
function durationOf(it: TaskGroupIterationRow): number | null {
  if (!it.startedAt || !it.completedAt) return null;
  return Math.max(0, it.completedAt.getTime() - it.startedAt.getTime());
}

/**
 * Build the metadata-only summary by EXPLICIT field map (MF-2). Never spread the
 * row: input/output/traceId must not appear. `triggeredBy` is admin-only.
 */
function toSummary(
  it: TaskGroupIterationRow,
  executions: TaskExecutionRow[],
  isAdmin: boolean,
): IterationSummary {
  const summary: IterationSummary = {
    iterationNumber: it.iterationNumber,
    status: it.status,
    startedAt: it.startedAt ? it.startedAt.toISOString() : null,
    completedAt: it.completedAt ? it.completedAt.toISOString() : null,
    durationMs: durationOf(it),
    completedCount: executions.filter((e) => e.status === "completed").length,
    taskCount: executions.length,
  };
  if (isAdmin) summary.triggeredBy = it.triggeredBy ?? null;
  return summary;
}

// ─── Route registration ─────────────────────────────────────────────────────

export function registerTaskIterationRoutes(router: Router, storage: IStorage): void {
  // LIST — metadata-only, keyset-paginated, virtual fallback for pre-v2 groups.
  router.get("/api/task-groups/:id/iterations", async (req: Request, res: Response) => {
    const groupId = String(req.params.id);
    const auth = await authorizeTaskGroup(req, res, storage, groupId);
    if (!auth) return;

    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query" });
    const isAdmin = req.user?.role === "admin";
    const limit = Math.min(parsed.data.limit ?? TASK_GROUP_V2_MAX_LIMIT, TASK_GROUP_V2_MAX_LIMIT);
    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
    if (parsed.data.cursor && !cursor) return res.status(400).json({ error: "Invalid cursor" });

    try {
      const rows = await storage.getIterations(groupId, {
        limit,
        cursor: cursor ?? undefined,
      });

      // MF-5: pre-v2 group with zero real iterations → synthesize iteration 1
      // INSIDE this authorized handler (never on an ungated path).
      if (rows.length === 0 && !cursor) {
        const virtual = await storage.getVirtualIteration(groupId);
        const items = virtual ? [toSummary(virtual.iteration, virtual.executions, isAdmin)] : [];
        return res.json({ items, nextCursor: null });
      }

      const items = await Promise.all(
        rows.map(async (it) => {
          const executions = await storage.getExecutionsByIteration(groupId, it.id);
          return toSummary(it, executions, isAdmin);
        }),
      );
      const nextCursor =
        rows.length === limit
          ? encodeCursor({ iterationNumber: rows[rows.length - 1].iterationNumber })
          : null;
      return res.json({ items, nextCursor });
    } catch {
      return res.status(500).json({ error: "Failed to load iterations" });
    }
  });

  // DETAIL — owner-gated, exposes executions (summary/error/output/model_slug).
  router.get("/api/task-groups/:id/iterations/:n", async (req: Request, res: Response) => {
    const groupId = String(req.params.id);
    const auth = await authorizeTaskGroup(req, res, storage, groupId);
    if (!auth) return;

    const iterationNumber = Number(req.params.n);
    if (!Number.isInteger(iterationNumber) || iterationNumber < 1) {
      return res.status(404).json({ error: "Iteration not found" });
    }

    try {
      const iteration = await resolveIteration(storage, groupId, iterationNumber);
      // Cross-group guard: the row must belong to the authorized group (MF-3).
      if (!iteration || iteration.groupId !== groupId) {
        return res.status(404).json({ error: "Iteration not found" });
      }
      const executions = await loadExecutions(storage, groupId, iteration, iterationNumber);
      return res.json({ iteration, executions });
    } catch {
      return res.status(500).json({ error: "Failed to load iteration" });
    }
  });

  // TRACE — MF-3: authorize → load iteration → assert group_id → scoped trace.
  router.get("/api/task-groups/:id/iterations/:n/trace", async (req: Request, res: Response) => {
    const groupId = String(req.params.id);
    const auth = await authorizeTaskGroup(req, res, storage, groupId);
    if (!auth) return;

    const iterationNumber = Number(req.params.n);
    if (!Number.isInteger(iterationNumber) || iterationNumber < 1) {
      return res.status(404).json({ error: "Iteration not found" });
    }

    try {
      const iteration = await resolveIteration(storage, groupId, iterationNumber);
      if (!iteration || iteration.groupId !== groupId) {
        return res.status(404).json({ error: "Iteration not found" });
      }
      const trace = await storage.getTaskTraceByIteration(groupId, iteration.id);
      if (!trace) return res.status(404).json({ error: "No trace for this iteration" });
      return res.json(trace);
    } catch {
      return res.status(500).json({ error: "Failed to load iteration trace" });
    }
  });
}

/** Resolve a real iteration by number, falling back to the virtual iteration 1. */
async function resolveIteration(
  storage: IStorage,
  groupId: string,
  iterationNumber: number,
): Promise<TaskGroupIterationRow | undefined> {
  const real = await storage.getIteration(groupId, iterationNumber);
  if (real) return real;
  if (iterationNumber !== 1) return undefined;
  const virtual = await storage.getVirtualIteration(groupId);
  return virtual?.iteration;
}

/** Load executions for the iteration (real or virtual), group-scoped (MF-1). */
async function loadExecutions(
  storage: IStorage,
  groupId: string,
  iteration: TaskGroupIterationRow,
  iterationNumber: number,
): Promise<TaskExecutionRow[]> {
  const scoped = await storage.getExecutionsByIteration(groupId, iteration.id);
  if (scoped.length > 0 || iterationNumber !== 1) return scoped;
  // Virtual iteration 1: its synthesized executions are not in the store.
  const virtual = await storage.getVirtualIteration(groupId);
  return virtual?.iteration.id === iteration.id ? virtual.executions : scoped;
}
