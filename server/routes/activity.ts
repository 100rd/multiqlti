/**
 * GET /api/activity — the read-only "Live Activity" observability lens.
 *
 * Returns an owner/admin-scoped snapshot of the runs that are active RIGHT NOW
 * across all four modes (pipeline / manager / orchestrator / consensus). The
 * authoritative live truth is the in-memory activeRuns registries of the two
 * controllers — NOT a DB status query (which lags the controllers).
 *
 * Scoping (shared authorizeRun rule, applied per run):
 *   - 401 if unauthenticated;
 *   - a non-admin sees ONLY runs whose pipeline_runs.triggeredBy === their id;
 *   - an admin sees ALL active runs and each row carries `ownerId`;
 *   - ownerless (triggeredBy == null) runs are HIDDEN from non-admins.
 *
 * Security — METADATA ONLY. Every row carries only: run id, mode, an
 * enum-derived label/agent/phase, a model slug, a status, a timestamp, and the
 * workspace id. NO transcript, prompt, task text, decision text, step output,
 * or reasoning ever enters this payload. `title` is a non-sensitive mode/name
 * label, never the user's free-text input.
 *
 * Mounted under the `/api/activity` requireAuth prefix in server/routes.ts.
 */
import type { Router, Request, Response } from "express";
import type { IStorage } from "../storage";
import type { PipelineController } from "../controller/pipeline-controller";
import type { ConsensusController } from "../consensus/consensus-controller";
import type {
  ActivityMode,
  ActivityRun,
  ActivityUnit,
  ActivitySnapshot,
} from "@shared/types";
import {
  orchestratorStepModel,
  managerTeamModel,
  type ActivityOrchestratorModels,
} from "./activity-model-map.js";

/** Hard cap on returned rows; we log (never silently drop) when we truncate. */
const MAX_ACTIVITY_ROWS = 200;

export interface ActivityRouteDeps {
  pipelineController: Pick<PipelineController, "getActiveRunIds">;
  consensusController: Pick<ConsensusController, "getActiveRunIds">;
  /** Fixed orchestrator model slugs (matches buildOrchestratorAgent). */
  orchestratorModels: ActivityOrchestratorModels;
  /** Claude slug the consensus engine pins for blind/adjudication. */
  consensusClaudeModelSlug: string;
}

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
  // review phase = the voter roster; blind/adjudication = Claude.
  const modelSlug = latest.phase === "review" ? null : claudeModelSlug;
  const agent = latest.phase === "review" ? "voters" : latest.phase;
  return {
    unit: {
      label: `Round ${latest.round} · ${latest.phase}`,
      agent,
      modelSlug,
      status,
    },
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
  // Current step = the running one, else the last completed/known step.
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
  const current =
    running ?? stages.find((s) => s.stageIndex === currentStageIndex) ?? undefined;
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

/**
 * Classify a run by mode and build its metadata-only Activity row. Returns null
 * when the run can't be classified (e.g. the row vanished mid-request).
 */
async function buildActivityRun(
  storage: IStorage,
  deps: ActivityRouteDeps,
  runId: string,
  ownerId: string | null,
  isAdmin: boolean,
): Promise<ActivityRun | null> {
  const run = await storage.getPipelineRun(runId);
  if (!run) return null;

  let mode: ActivityMode;
  let title: string;
  let unitResult: { unit: ActivityUnit | null; status: string };

  const consensus = await storage.getConsensusRun(runId);
  if (consensus) {
    mode = "consensus";
    title = "Consensus run";
    unitResult = await consensusUnit(storage, runId, deps.consensusClaudeModelSlug);
  } else {
    const orchestrator = await storage.getOrchestratorRun(runId);
    if (orchestrator) {
      mode = "orchestrator";
      title = "Orchestrator run";
      unitResult = await orchestratorUnit(storage, runId, deps.orchestratorModels);
    } else {
      const managerResult = await managerUnit(storage, runId, run.status);
      if (managerResult) {
        mode = "manager";
        title = "Manager run";
        unitResult = managerResult;
      } else {
        mode = "pipeline";
        title = "Pipeline run";
        unitResult = await pipelineUnit(
          storage,
          runId,
          run.currentStageIndex,
          run.status,
        );
      }
    }
  }

  const row: ActivityRun = {
    runId,
    mode,
    title,
    status: unitResult.status,
    workspaceId: run.workspaceId ?? null,
    currentUnit: unitResult.unit,
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
  };
  // Owner attribution is admin-only.
  if (isAdmin) row.ownerId = ownerId;
  return row;
}

export function registerActivityRoutes(
  router: Router,
  storage: IStorage,
  deps: ActivityRouteDeps,
): void {
  router.get("/api/activity", async (req: Request, res: Response) => {
    if (!req.user?.id) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const userId = req.user.id;
    const isAdmin = req.user.role === "admin";

    try {
      // Union the two registries (pipeline+manager+orchestrator ∪ consensus).
      const candidateIds = [
        ...deps.pipelineController.getActiveRunIds(),
        ...deps.consensusController.getActiveRunIds(),
      ];
      const uniqueIds = [...new Set(candidateIds)];

      const rows: ActivityRun[] = [];
      let truncated = false;

      for (const runId of uniqueIds) {
        const run = await storage.getPipelineRun(runId);
        if (!run) continue; // registry/DB raced — skip.

        // Single ownership gate for ALL modes via pipeline_runs.triggeredBy.
        const isOwner = run.triggeredBy != null && run.triggeredBy === userId;
        if (!isAdmin && !isOwner) continue; // hides others' + ownerless from non-admins.

        if (rows.length >= MAX_ACTIVITY_ROWS) {
          truncated = true;
          break;
        }

        const row = await buildActivityRun(storage, deps, runId, run.triggeredBy, isAdmin);
        if (row) rows.push(row);
      }

      if (truncated) {
        console.warn(
          `[activity] row cap hit: ${uniqueIds.length} candidate active runs > ${MAX_ACTIVITY_ROWS} cap; response truncated`,
        );
      }

      const snapshot: ActivitySnapshot = { runs: rows, isAdmin, truncated };
      return res.json(snapshot);
    } catch {
      // Generic — never leak internal detail.
      return res.status(500).json({ error: "Failed to load activity" });
    }
  });
}
