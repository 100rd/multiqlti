/**
 * /consensus routes (additive run mode). Mounted under the `/api/runs`
 * requireAuth prefix in server/routes.ts. Sibling of routes/orchestrator.ts.
 *
 * Security (mirrors the orchestrator route idiom):
 *   - kill-switch: POST returns 503 when pipeline.consensus.enabled is false (the
 *     controller branch ALSO enforces this — defense in depth);
 *   - AuthZ: owner-or-admin via the run's triggeredBy, STRICTER — DENY when
 *     triggeredBy == null (consensus transcripts are never world-readable).
 *     Ordering: 401 unauth → 404 missing → 403 non-owner;
 *   - workspaceId owner-gate on start (deny binding to another user's workspace);
 *   - rate-limited via checkManagerRunRateLimit (the run is expensive);
 *   - generic client error messages (no internal detail leak);
 *   - decisionText is bounded (<=50_000) at the schema and treated as untrusted
 *     (the engine C3-wraps it before any prompt).
 */
import type { Router, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { ConsensusController } from "../consensus/consensus-controller";
import { validateBody } from "../middleware/validate.js";
import { checkManagerRunRateLimit } from "./runs.js";
import { configLoader } from "../config/loader.js";

const ConsensusCapsSchema = z
  .object({
    maxRounds: z.number().int().min(1).max(5).optional(),
    voterCount: z.number().int().min(5).max(7).optional(),
    maxTotalTokens: z.number().int().min(1000).max(2_000_000).optional(),
  })
  .optional();

const StartConsensusSchema = z.object({
  decisionText: z.string().min(1).max(50_000),
  workspaceId: z.string().max(100).optional(),
  caps: ConsensusCapsSchema,
});

/**
 * Resolve auth for a consensus run. Returns the owner on success, or sends the
 * correct status (401/404/403) and returns null. STRICTER than the manager
 * idiom: triggeredBy == null is DENIED (unless admin).
 */
async function authorizeRun(
  req: Request,
  res: Response,
  storage: IStorage,
  runId: string,
): Promise<{ ownerId: string | null } | null> {
  // 401 first — unauth takes precedence over existence.
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }

  const run = await storage.getPipelineRun(runId);
  const consensus = run ? await storage.getConsensusRun(runId) : undefined;
  if (!run || !consensus) {
    res.status(404).json({ error: "Run not found" });
    return null;
  }

  const isAdmin = req.user.role === "admin";
  const isOwner = run.triggeredBy != null && run.triggeredBy === req.user.id;
  // Deny when ownerless (stricter than manager) unless admin.
  if (!isAdmin && !isOwner) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  return { ownerId: run.triggeredBy };
}

export function registerConsensusRoutes(
  router: Router,
  storage: IStorage,
  controller: ConsensusController,
): void {
  // ── Start ──────────────────────────────────────────────────────────────────
  router.post(
    "/api/runs/consensus",
    validateBody(StartConsensusSchema),
    async (req: Request, res: Response) => {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      // Kill-switch at the route (controller re-checks).
      if (!configLoader.get().pipeline.consensus.enabled) {
        return res.status(503).json({ error: "Consensus mode is disabled" });
      }
      // Rate-limit the start endpoint (the run is expensive).
      const { allowed, retryAfterMs } = checkManagerRunRateLimit(req.user.id);
      if (!allowed) {
        res.setHeader("Retry-After", Math.ceil((retryAfterMs ?? 60_000) / 1000).toString());
        return res
          .status(429)
          .json({ error: "Too many runs. Please wait before starting another." });
      }

      const body = req.body as z.infer<typeof StartConsensusSchema>;
      if (body.workspaceId) {
        const ws = await storage.getWorkspace(body.workspaceId);
        if (!ws) return res.status(400).json({ error: "Workspace not found" });
        // Owner-gate the binding (deny binding to another user's workspace).
        const isAdmin = req.user.role === "admin";
        const ownerOk = ws.ownerId == null || ws.ownerId === req.user.id;
        if (!ownerOk && !isAdmin) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      try {
        const result = await controller.startConsensusRun(
          { decisionText: body.decisionText, workspaceId: body.workspaceId, caps: body.caps },
          req.user.id,
        );
        return res.status(201).json({ runId: result.runId, status: result.status });
      } catch (err) {
        // Controller kill-switch → 503; otherwise generic 500.
        const msg = err instanceof Error ? err.message : "";
        if (/disabled/i.test(msg)) {
          return res.status(503).json({ error: "Consensus mode is disabled" });
        }
        return res.status(500).json({ error: "Failed to start consensus run" });
      }
    },
  );

  // ── Inspect (summary) ────────────────────────────────────────────────────────
  router.get("/api/runs/:id/consensus", async (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const auth = await authorizeRun(req, res, storage, runId);
    if (!auth) return;

    const consensusRun = await storage.getConsensusRun(runId);
    return res.json({ consensusRun });
  });

  // ── Rounds (transcripts) ─────────────────────────────────────────────────────
  router.get("/api/runs/:id/consensus/rounds", async (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const auth = await authorizeRun(req, res, storage, runId);
    if (!auth) return;
    const rounds = await storage.getConsensusRounds(runId);
    return res.json({ runId, rounds });
  });

  // ── Issues (the critical-issue ledger) ─────────────────────────────────────────
  router.get("/api/runs/:id/consensus/issues", async (req: Request, res: Response) => {
    const runId = String(req.params.id);
    const auth = await authorizeRun(req, res, storage, runId);
    if (!auth) return;
    const issues = await storage.getConsensusIssues(runId);
    return res.json({ runId, issues });
  });
}
