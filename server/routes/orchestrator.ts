/**
 * Debate-research orchestrator routes (additive 3rd run mode). Mounted under the
 * `/api/runs` requireAuth prefix in server/routes.ts.
 *
 * Security:
 *   - L1: POST /orchestrator returns 503 when pipeline.orchestrator.enabled is
 *     false (the controller branch ALSO enforces this — defense in depth).
 *   - AuthZ: owner-or-admin via the run's triggeredBy (manager-iterations idiom),
 *     but STRICTER — DENY when triggeredBy == null (orchestrator transcripts are
 *     never world-readable). Ordering: 401 unauth → 404 missing → 403 non-owner.
 *   - M2: BOTH start and approve-plan are rate-limited (approve resumes the
 *     expensive work).
 *   - H3: approve-plan with edited steps[] is re-validated + re-clamped server
 *     side by the controller (validateSteps + resolveCaps).
 *   - Generic client error messages (no internal detail leak).
 */
import type { Router, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { PipelineController } from "../controller/pipeline-controller";
import { validateBody } from "../middleware/validate.js";
import { checkManagerRunRateLimit } from "./runs.js";
import { configLoader } from "../config/loader.js";
import { StepSchema } from "../orchestrator/plan-schema.js";
import { authorizeRun as sharedAuthorizeRun } from "./authorize-run.js";

const CapsSchema = z
  .object({
    maxDebateRounds: z.number().int().min(1).max(5).optional(),
    maxResearchSources: z.number().int().min(1).max(50).optional(),
    maxSteps: z.number().int().min(1).max(20).optional(),
    maxTotalTokens: z.number().int().min(1000).max(2_000_000).optional(),
  })
  .optional();

const StartOrchestratorSchema = z.object({
  task: z.string().min(1).max(50_000),
  needs: z.string().max(50_000).optional(),
  workspaceId: z.string().max(100).optional(),
  caps: CapsSchema,
});

const ApprovePlanSchema = z.object({
  approvedBy: z.string().max(200).optional(),
  steps: z.array(StepSchema).max(20).optional(),
  caps: CapsSchema,
});

/**
 * Resolve auth for an orchestrator run via the shared helper, also requiring the
 * orchestrator_runs row to exist (404 otherwise). Behavior-preserving wrapper.
 */
function authorizeRun(
  req: Request,
  res: Response,
  storage: IStorage,
  runId: string,
): Promise<{ ownerId: string | null } | null> {
  return sharedAuthorizeRun(req, res, storage, runId, {
    requireModeRow: (s, id) => s.getOrchestratorRun(id),
  });
}

export function registerOrchestratorRoutes(
  router: Router,
  storage: IStorage,
  controller: PipelineController,
): void {
  // ── Start ──────────────────────────────────────────────────────────────────
  router.post(
    "/api/runs/orchestrator",
    validateBody(StartOrchestratorSchema),
    async (req: Request, res: Response) => {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      // L1: kill-switch at the route (controller re-checks).
      if (!configLoader.get().pipeline.orchestrator.enabled) {
        return res.status(503).json({ error: "Orchestrator mode is disabled" });
      }
      // M2: rate-limit the start endpoint.
      const { allowed, retryAfterMs } = checkManagerRunRateLimit(req.user.id);
      if (!allowed) {
        res.setHeader("Retry-After", Math.ceil((retryAfterMs ?? 60_000) / 1000).toString());
        return res
          .status(429)
          .json({ error: "Too many runs. Please wait before starting another." });
      }

      const body = req.body as z.infer<typeof StartOrchestratorSchema>;
      if (body.workspaceId) {
        const ws = await storage.getWorkspace(body.workspaceId);
        if (!ws) return res.status(400).json({ error: "Workspace not found" });
        // H-WS-1: owner-gate the binding. The analyze-code step reads this
        // workspace's source; binding to another user's workspace would
        // exfiltrate their private code into the prompt + transcript. Deny
        // unless the workspace is ownerless, owned by the caller, or admin.
        const isAdmin = req.user.role === "admin";
        const ownerOk = ws.ownerId == null || ws.ownerId === req.user.id;
        if (!ownerOk && !isAdmin) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      try {
        const { run, orchestratorRunId, plan } = await controller.startOrchestratorRun(
          { task: body.task, needs: body.needs },
          req.user.id,
          body.workspaceId,
          body.caps,
        );
        return res.status(201).json({
          runId: run.id,
          orchestratorRunId,
          status: "awaiting_plan_approval",
          plan,
        });
      } catch {
        // Generic — never leak internal plan-turn detail.
        return res.status(500).json({ error: "Failed to start orchestrator run" });
      }
    },
  );

  // ── Inspect ──────────────────────────────────────────────────────────────────
  router.get("/api/runs/:id/orchestrator", async (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const auth = await authorizeRun(req, res, storage, runId);
    if (!auth) return;

    const orchestratorRun = await storage.getOrchestratorRun(runId);
    const steps = await storage.getOrchestratorSteps(runId);
    return res.json({
      orchestratorRun,
      steps,
      totalTokensUsed: orchestratorRun?.totalTokensUsed ?? 0,
    });
  });

  // ── Approve plan (human gate) ────────────────────────────────────────────────
  router.post(
    "/api/runs/:id/orchestrator/approve-plan",
    validateBody(ApprovePlanSchema),
    async (req: Request, res: Response) => {
      const runId = String(req.params.id);
      const auth = await authorizeRun(req, res, storage, runId);
      if (!auth) return;

      // M2: rate-limit approve too (it resumes the expensive work).
      const limit = checkManagerRunRateLimit(req.user!.id);
      if (!limit.allowed) {
        res.setHeader("Retry-After", Math.ceil((limit.retryAfterMs ?? 60_000) / 1000).toString());
        return res.status(429).json({ error: "Too many approvals. Please wait." });
      }

      const body = req.body as z.infer<typeof ApprovePlanSchema>;
      const orch = await storage.getOrchestratorRun(runId);
      if (orch?.status !== "awaiting_plan_approval") {
        return res.status(409).json({ error: "Run is not awaiting plan approval" });
      }

      try {
        // H3: edited steps re-validated + caps re-clamped inside the controller.
        await controller.approvePlan(runId, body.approvedBy, body.steps, body.caps);
        return res.json({ status: "executing" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (/Edited plan rejected/i.test(msg)) {
          return res.status(400).json({ error: "Edited plan rejected" });
        }
        if (/not awaiting/i.test(msg)) {
          return res.status(409).json({ error: "Run is not awaiting plan approval" });
        }
        return res.status(500).json({ error: "Failed to approve plan" });
      }
    },
  );

  // ── Reject plan ──────────────────────────────────────────────────────────────
  router.post("/api/runs/:id/orchestrator/reject-plan", async (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const auth = await authorizeRun(req, res, storage, runId);
    if (!auth) return;
    try {
      await controller.rejectPlan(runId);
      return res.json({ status: "cancelled" });
    } catch {
      return res.status(500).json({ error: "Failed to reject plan" });
    }
  });

  // ── Debates (transcripts) ──────────────────────────────────────────────────────
  router.get("/api/runs/:id/orchestrator/debates", async (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const auth = await authorizeRun(req, res, storage, runId);
    if (!auth) return;
    const debates = await storage.getOrchestratorDebates(runId);
    return res.json({ runId, debates });
  });

  // ── Research (cited findings) ────────────────────────────────────────────────
  router.get("/api/runs/:id/orchestrator/research", async (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const auth = await authorizeRun(req, res, storage, runId);
    if (!auth) return;
    const research = await storage.getOrchestratorResearch(runId);
    return res.json({ runId, research });
  });
}
