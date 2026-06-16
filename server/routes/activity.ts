/**
 * /api/activity — the read-only "Live Activity" observability lens + its History
 * tab.
 *
 * GET /api/activity            — owner/admin-scoped snapshot of runs active NOW
 *                                across all FIVE modes (pipeline / manager /
 *                                orchestrator / consensus / task_group).
 * GET /api/activity/history    — DB-backed list of PAST (terminal) runs across
 *                                all modes, owner/admin-scoped, METADATA-ONLY,
 *                                keyset-paginated (H1/H4).
 *
 * Scoping (shared isVisible rule, applied per run):
 *   - 401 if unauthenticated;
 *   - a non-admin sees ONLY runs they own (pipeline-family via
 *     pipeline_runs.triggeredBy; task-groups via task_groups.createdBy);
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
import type { PipelineController } from "../controller/pipeline-controller";
import type { ConsensusController } from "../consensus/consensus-controller";
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
import {
  orchestratorStepModel,
  managerTeamModel,
  type ActivityOrchestratorModels,
} from "./activity-model-map.js";

/** Hard cap on returned rows; we log (never silently drop) when we truncate. */
const MAX_ACTIVITY_ROWS = 200;

/** History pagination bounds (H4). */
const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;

/** FIXED mode labels — never the user's free-text name. */
const MODE_TITLES: Record<ActivityMode, string> = {
  pipeline: "Pipeline run",
  manager: "Manager run",
  orchestrator: "Orchestrator run",
  consensus: "Consensus run",
  task_group: "Task group",
};

export interface ActivityRouteDeps {
  pipelineController: Pick<PipelineController, "getActiveRunIds">;
  consensusController: Pick<ConsensusController, "getActiveRunIds">;
  /** Optional — the task orchestrator's in-flight group ids (live task_group rows). */
  taskOrchestrator?: Pick<TaskOrchestrator, "getActiveGroupIds">;
  /** Fixed orchestrator model slugs (matches buildOrchestratorAgent). */
  orchestratorModels: ActivityOrchestratorModels;
  /** Claude slug the consensus engine pins for blind/adjudication. */
  consensusClaudeModelSlug: string;
}

// ─── Current-unit builders (metadata only) ────────────────────────────────────

/** Build the current-unit summary for a CONSENSUS run (metadata only). */
async function consensusUnit(
  storage: IStorage,
  runId: string,
  claudeModelSlug: string,
): Promise<{ unit: ActivityUnit | null; status: string }> {
  const run = await storage.getConsensusRun(runId);
  const rounds = await storage.getConsensusRounds(runId);
  const latest = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;
  const status = run?.status ?? "deliberating";
  if (!latest) {
    return { unit: { label: "Round 0", agent: "consensus", modelSlug: null, status }, status };
  }
  const modelSlug = latest.phase === "review" ? null : claudeModelSlug;
  const agent = latest.phase === "review" ? "voters" : latest.phase;
  return {
    unit: { label: `Round ${latest.round} · ${latest.phase}`, agent, modelSlug, status },
    status,
  };
}

/** Build the current-unit summary for an ORCHESTRATOR run (metadata only). */
async function orchestratorUnit(
  storage: IStorage,
  runId: string,
  models: ActivityOrchestratorModels,
): Promise<{ unit: ActivityUnit | null; status: string }> {
  const run = await storage.getOrchestratorRun(runId);
  const steps = await storage.getOrchestratorSteps(runId);
  const status = run?.status ?? "executing";
  const running = steps.find((s) => s.status === "running");
  const current = running ?? (steps.length > 0 ? steps[steps.length - 1] : undefined);
  if (!current) return { unit: null, status };
  return {
    unit: {
      label: `Step ${current.stepIndex + 1}`,
      agent: current.type,
      modelSlug: orchestratorStepModel(current.type, models),
      status: current.status,
    },
    status,
  };
}

/** Build the current-unit summary for a MANAGER run (best-effort model). */
async function managerUnit(
  storage: IStorage,
  runId: string,
  runStatus: string,
): Promise<{ unit: ActivityUnit | null; status: string } | null> {
  const iterations = await storage.getManagerIterations(runId);
  if (iterations.length === 0) return null;
  const latest = iterations[iterations.length - 1];
  const teamId = latest.decision?.teamId;
  return {
    unit: {
      label: `Iteration ${latest.iterationNumber}`,
      agent: teamId ?? latest.decision?.action ?? "manager",
      modelSlug: managerTeamModel(teamId),
      status: runStatus,
    },
    status: runStatus,
  };
}

/** Build the current-unit summary for a PIPELINE run (linear or DAG). */
async function pipelineUnit(
  storage: IStorage,
  runId: string,
  currentStageIndex: number,
  runStatus: string,
): Promise<{ unit: ActivityUnit | null; status: string }> {
  const stages = await storage.getStageExecutions(runId);
  const running = stages.find((s) => s.status === "running");
  const current = running ?? stages.find((s) => s.stageIndex === currentStageIndex) ?? undefined;
  if (!current) return { unit: null, status: runStatus };
  return {
    unit: {
      label: `Stage ${current.stageIndex + 1}`,
      agent: current.teamId,
      modelSlug: current.modelSlug ?? null,
      status: current.status,
    },
    status: runStatus,
  };
}

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

// ─── Classification (live + history share this) ───────────────────────────────

interface ClassifiedRun {
  mode: ActivityMode;
  title: string;
  unitResult: { unit: ActivityUnit | null; status: string };
}

/**
 * Classify a pipeline_runs-keyed run by mode and build its metadata-only
 * current-unit. Shared by the live snapshot and the history endpoint so the two
 * agree. Returns null when the parent pipeline_runs row is gone.
 */
async function classifyPipelineFamily(
  storage: IStorage,
  deps: Pick<ActivityRouteDeps, "consensusClaudeModelSlug" | "orchestratorModels">,
  runId: string,
): Promise<ClassifiedRun | null> {
  const run = await storage.getPipelineRun(runId);
  if (!run) return null;

  const consensus = await storage.getConsensusRun(runId);
  if (consensus) {
    return {
      mode: "consensus",
      title: MODE_TITLES.consensus,
      unitResult: await consensusUnit(storage, runId, deps.consensusClaudeModelSlug),
    };
  }
  const orchestrator = await storage.getOrchestratorRun(runId);
  if (orchestrator) {
    return {
      mode: "orchestrator",
      title: MODE_TITLES.orchestrator,
      unitResult: await orchestratorUnit(storage, runId, deps.orchestratorModels),
    };
  }
  const managerResult = await managerUnit(storage, runId, run.status);
  if (managerResult) {
    return { mode: "manager", title: MODE_TITLES.manager, unitResult: managerResult };
  }
  return {
    mode: "pipeline",
    title: MODE_TITLES.pipeline,
    unitResult: await pipelineUnit(storage, runId, run.currentStageIndex, run.status),
  };
}

/** Build a metadata-only live ActivityRun for a pipeline-family run. */
async function buildActivityRun(
  storage: IStorage,
  deps: ActivityRouteDeps,
  runId: string,
  ownerId: string | null,
  isAdmin: boolean,
): Promise<ActivityRun | null> {
  const classified = await classifyPipelineFamily(storage, deps, runId);
  if (!classified) return null;
  const run = await storage.getPipelineRun(runId);
  if (!run) return null;

  const row: ActivityRun = {
    runId,
    mode: classified.mode,
    title: classified.title,
    status: classified.unitResult.status,
    workspaceId: run.workspaceId ?? null,
    currentUnit: classified.unitResult.unit,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
  };
  if (isAdmin) row.ownerId = ownerId;
  return row;
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
  mode: z.enum(["pipeline", "manager", "orchestrator", "consensus", "task_group"]).optional(),
});

/** A merged history candidate keyed on the global (completedAt, id) ordering. */
interface HistoryCandidate {
  id: string;
  completedAt: Date | null;
  isTaskGroup: boolean;
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
      const pipelineFamilyIds = [
        ...deps.pipelineController.getActiveRunIds(),
        ...deps.consensusController.getActiveRunIds(),
      ];
      const groupIds = deps.taskOrchestrator?.getActiveGroupIds() ?? [];
      const uniquePipeline = [...new Set(pipelineFamilyIds)];
      const uniqueGroups = [...new Set(groupIds)];

      const rows: ActivityRun[] = [];
      let truncated = false;

      // Pipeline-family rows — owner gate via pipeline_runs.triggeredBy.
      for (const runId of uniquePipeline) {
        const run = await storage.getPipelineRun(runId);
        if (!run) continue;
        if (!isVisible(run.triggeredBy, req.user)) continue;
        if (rows.length >= MAX_ACTIVITY_ROWS) {
          truncated = true;
          break;
        }
        const row = await buildActivityRun(storage, deps, runId, run.triggeredBy, isAdmin);
        if (row) rows.push(row);
      }

      // Task-group rows — owner gate via task_groups.createdBy.
      if (!truncated) {
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

      const wantPipeline = mode !== "task_group";
      const wantGroups = mode === undefined || mode === "task_group";

      // Over-fetch `limit` from each source; merge by the global keyset ordering.
      const pipelineRows = wantPipeline ? await storage.listPipelineRunHistory(baseQuery) : [];
      const groupRows = wantGroups ? await storage.listTaskGroupHistory(baseQuery) : [];

      const candidates: HistoryCandidate[] = [
        ...pipelineRows.map((r) => ({ id: r.id, completedAt: r.completedAt, isTaskGroup: false })),
        ...groupRows.map((r) => ({ id: r.id, completedAt: r.completedAt, isTaskGroup: true })),
      ];
      candidates.sort(cmpCandidates);
      const page = candidates.slice(0, limit);

      const items: ActivityHistoryRow[] = [];
      for (const cand of page) {
        const row = cand.isTaskGroup
          ? await buildTaskGroupHistoryRow(storage, cand.id, isAdmin)
          : await buildPipelineHistoryRow(storage, deps, cand.id, isAdmin);
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

async function buildPipelineHistoryRow(
  storage: IStorage,
  deps: Pick<ActivityRouteDeps, "consensusClaudeModelSlug" | "orchestratorModels">,
  runId: string,
  isAdmin: boolean,
): Promise<ActivityHistoryRow | null> {
  const run = await storage.getPipelineRun(runId);
  if (!run) return null;
  const classified = await classifyPipelineFamily(storage, deps, runId);
  if (!classified) return null;

  // Explicit allowlist — only enum/id/timestamp fields; NO output/input/summary.
  const row: ActivityHistoryRow = {
    runId,
    mode: classified.mode,
    title: classified.title,
    status: run.status,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    currentUnit: classified.unitResult.unit,
    workspaceId: run.workspaceId ?? null,
  };
  if (isAdmin) row.ownerId = run.triggeredBy ?? null;
  return row;
}

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
