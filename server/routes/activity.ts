/**
 * /api/activity — the read-only "Live Activity" observability lens + its History
 * tab.
 *
 * GET /api/activity            — owner/admin-scoped snapshot of task groups
 *                                active NOW.
 * GET /api/activity/history    — DB-backed list of PAST (terminal) task groups,
 *                                owner/admin-scoped, METADATA-ONLY,
 *                                keyset-paginated (H1/H4).
 *
 * Scoping (shared isVisible rule, applied per run):
 *   - 401 if unauthenticated;
 *   - a non-admin sees ONLY runs they own (task-groups via
 *     task_groups.createdBy);
 *   - an admin sees ALL runs and each row carries `ownerId`;
 *   - ownerless runs are HIDDEN from non-admins.
 *
 * Security — METADATA ONLY. Every row carries only: id, mode, an enum-derived
 * label/agent/phase, a model slug, a status, timestamps, and the workspace id.
 * NO transcript, prompt, task text, decision text, step output, summary,
 * errorMessage, or reasoning ever enters this payload. The history row is built
 * by an explicit ALLOWLIST, never by spreading a DB row. `title` is a FIXED mode
 * label, never the user's free-text name.
 *
 * Mounted under the `/api/activity` requireAuth prefix in server/routes.ts.
 */
import { z } from "zod";
import type { Router, Request, Response } from "express";
import type { IStorage, RunHistoryQuery } from "../storage";
import type { TaskOrchestrator } from "../services/task-orchestrator";
import type {
  ActivityMode,
  ActivityRun,
  ActivityUnit,
  ActivitySnapshot,
  ActivityHistoryRow,
  ActivityHistoryPage,
} from "@shared/types";
import { isVisible } from "./authorize-run.js";

/** Hard cap on returned rows; we log (never silently drop) when we truncate. */
const MAX_ACTIVITY_ROWS = 200;

/** History pagination bounds (H4). */
const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;

/** FIXED mode labels — never the user's free-text name. */
const MODE_TITLES: Record<ActivityMode, string> = {
  task_group: "Task group",
};

export interface ActivityRouteDeps {
  /** Optional — the task orchestrator's in-flight group ids (live task_group rows). */
  taskOrchestrator?: Pick<TaskOrchestrator, "getActiveGroupIds">;
}

// ─── Current-unit builders (metadata only) ────────────────────────────────────

/** Build the current-unit summary for a TASK GROUP (running/last task). */
async function taskGroupUnit(
  storage: IStorage,
  groupId: string,
  groupStatus: string,
): Promise<{ unit: ActivityUnit | null; status: string }> {
  const tasks = await storage.getTasksByGroup(groupId);
  if (tasks.length === 0) return { unit: null, status: groupStatus };
  const running = tasks.find((t) => t.status === "running");
  const current = running ?? tasks[tasks.length - 1];
  // Agent = the executionMode (enum), model = the task's model slug. NO task text.
  return {
    unit: {
      label: `Task ${current.sortOrder + 1}`,
      agent: current.executionMode,
      modelSlug: current.modelSlug ?? null,
      status: current.status,
    },
    status: groupStatus,
  };
}

/** Build a metadata-only live ActivityRun for a task group. */
async function buildTaskGroupRun(
  storage: IStorage,
  groupId: string,
  ownerId: string | null,
  isAdmin: boolean,
): Promise<ActivityRun | null> {
  const group = await storage.getTaskGroup(groupId);
  if (!group) return null;
  const unitResult = await taskGroupUnit(storage, groupId, group.status);
  const row: ActivityRun = {
    runId: groupId,
    mode: "task_group",
    title: MODE_TITLES.task_group,
    status: group.status,
    workspaceId: null,
    currentUnit: unitResult.unit,
    startedAt: group.startedAt ? group.startedAt.toISOString() : null,
  };
  if (isAdmin) row.ownerId = ownerId;
  return row;
}

// ─── History cursor (opaque base64 keyset, Zod-validated) ──────────────────────

const CursorSchema = z.object({
  completedAt: z.string().datetime(),
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

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(2000).optional(),
  mode: z.enum(["task_group"]).optional(),
});

/** A merged history candidate keyed on the global (completedAt, id) ordering. */
interface HistoryCandidate {
  id: string;
  completedAt: Date | null;
}

/** Sort two candidates by (completedAt desc, id desc). null completedAt sorts last. */
function cmpCandidates(a: HistoryCandidate, b: HistoryCandidate): number {
  const ta = a.completedAt ? a.completedAt.getTime() : -Infinity;
  const tb = b.completedAt ? b.completedAt.getTime() : -Infinity;
  if (ta !== tb) return tb - ta;
  return b.id.localeCompare(a.id);
}

// ─── Route registration ────────────────────────────────────────────────────

export function registerActivityRoutes(
  router: Router,
  storage: IStorage,
  deps: ActivityRouteDeps,
): void {
  // ── Live snapshot ──────────────────────────────────────────────────────────
  router.get("/api/activity", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    const isAdmin = req.user.role === "admin";

    try {
      const groupIds = deps.taskOrchestrator?.getActiveGroupIds() ?? [];
      const uniqueGroups = [...new Set(groupIds)];

      const rows: ActivityRun[] = [];
      let truncated = false;

      // Task-group rows — owner gate via task_groups.createdBy.
      for (const groupId of uniqueGroups) {
        const group = await storage.getTaskGroup(groupId);
        if (!group) continue;
        if (!isVisible(group.createdBy, req.user)) continue;
        if (rows.length >= MAX_ACTIVITY_ROWS) {
          truncated = true;
          break;
        }
        const row = await buildTaskGroupRun(storage, groupId, group.createdBy, isAdmin);
        if (row) rows.push(row);
      }

      if (truncated) {
        console.warn(
          `[activity] row cap hit: candidate active runs > ${MAX_ACTIVITY_ROWS} cap; response truncated`,
        );
      }

      const snapshot: ActivitySnapshot = { runs: rows, isAdmin, truncated };
      return res.json(snapshot);
    } catch {
      return res.status(500).json({ error: "Failed to load activity" });
    }
  });

  // ── History tab (terminal runs, DB-backed, metadata-only, keyset) ────────────
  router.get("/api/activity/history", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    const isAdmin = req.user.role === "admin";
    const ownerId = isAdmin ? undefined : req.user.id; // SQL owner filter for non-admins.

    const parsedQuery = HistoryQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: "Invalid query parameters" });
    }
    const { mode } = parsedQuery.data;
    const limit = Math.min(parsedQuery.data.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);

    let cursor: Cursor | undefined;
    if (parsedQuery.data.cursor) {
      const decoded = decodeCursor(parsedQuery.data.cursor);
      if (!decoded) return res.status(400).json({ error: "Invalid cursor" });
      cursor = decoded;
    }

    try {
      const baseQuery: RunHistoryQuery = {
        ownerId,
        limit,
        cursor: cursor ? { completedAt: cursor.completedAt, id: cursor.id } : undefined,
      };

      // Over-fetch `limit`; sorted by the global keyset ordering.
      const groupRows = await storage.listTaskGroupHistory(baseQuery);

      const candidates: HistoryCandidate[] = groupRows.map((r) => ({
        id: r.id,
        completedAt: r.completedAt,
      }));
      candidates.sort(cmpCandidates);
      const page = candidates.slice(0, limit);

      const items: ActivityHistoryRow[] = [];
      for (const cand of page) {
        const row = await buildTaskGroupHistoryRow(storage, cand.id, isAdmin);
        if (row) {
          // Mode filter (defense in depth — already partitioned by source).
          if (mode && row.mode !== mode) continue;
          items.push(row);
        }
      }

      const last = page[page.length - 1];
      const nextCursor =
        page.length === limit && last
          ? encodeCursor({
              completedAt: (last.completedAt ?? new Date(0)).toISOString(),
              id: last.id,
            })
          : null;

      const payload: ActivityHistoryPage = { items, nextCursor, isAdmin };
      return res.json(payload);
    } catch {
      return res.status(500).json({ error: "Failed to load activity history" });
    }
  });
}

// ─── History row builders (ALLOWLIST — never spread a DB row) ───────────────────

async function buildTaskGroupHistoryRow(
  storage: IStorage,
  groupId: string,
  isAdmin: boolean,
): Promise<ActivityHistoryRow | null> {
  const group = await storage.getTaskGroup(groupId);
  if (!group) return null;
  const unitResult = await taskGroupUnit(storage, groupId, group.status);

  // Explicit allowlist — FIXED title (NEVER group.name), no output/summary/input.
  const row: ActivityHistoryRow = {
    runId: groupId,
    mode: "task_group",
    title: MODE_TITLES.task_group,
    status: group.status,
    startedAt: group.startedAt ? group.startedAt.toISOString() : null,
    completedAt: group.completedAt ? group.completedAt.toISOString() : null,
    currentUnit: unitResult.unit,
    workspaceId: null,
  };
  if (isAdmin) row.ownerId = group.createdBy ?? null;
  return row;
}
