/**
 * execute-sdlc.ts — POST /api/task-groups/:groupId/execute-sdlc
 *                 + GET  /api/task-groups/:groupId/execute-sdlc/status
 *
 * The HTTP surface a maintainer's "Execute verdict" button calls: EXECUTE the
 * group's latest consilium verdict's `action_points` directly via the SDLC
 * executor (one isolated worktree, one coder run + commit per action point, ONE
 * Draft PR), replacing the legacy "hand off to a pipeline" mechanism.
 *
 * Auth: mounted under `/api/task-groups` (requireAuth + requireProject in
 * routes.ts), so the handler runs inside the request's project ALS. Every per-id
 * route ALSO runs `authorizeTaskGroup` (owner-or-admin, closes the C1 IDOR) — this
 * triggers REAL code execution + a Draft PR, so the caller MUST be able to see the
 * group. Registered ONLY inside the consilium-loop kill-switch block (inert
 * otherwise), exactly like POST /api/consilium-reviews.
 *
 * SECURITY: action points are SERVER-READ from the verdict (the body's are
 * ignored — the zod schema only surfaces an optional repoPath). repoPath is
 * allowlist + workspace gated inside the service. Draft-PR-only — agents never
 * merge. See `server/services/consilium/execute-sdlc.ts` for the full surface.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage.js";
import { validateBody } from "../middleware/validate.js";
import { authorizeTaskGroup } from "./authorize-task-group.js";
import { ExecuteSdlcError, type SdlcExecutionService } from "../services/consilium/execute-sdlc.js";

/**
 * Body schema: ONLY an optional repoPath fallback (used when the group has no
 * consilium loop to source the repoPath from). zod `.object` STRIPS unknown keys,
 * so a client-supplied `action_points` is silently dropped and NEVER read — the
 * verdict is the only source of action points.
 */
const ExecuteSdlcSchema = z.object({
  repoPath: z.string().min(1).max(4096).optional(),
});

export function registerExecuteSdlcRoutes(
  app: Express,
  storage: IStorage,
  service: SdlcExecutionService,
): void {
  // POST /api/task-groups/:groupId/execute-sdlc — launch (or dedup) the run.
  app.post(
    "/api/task-groups/:groupId/execute-sdlc",
    validateBody(ExecuteSdlcSchema),
    async (req: Request, res: Response) => {
      const groupId = String(req.params.groupId);
      const authorized = await authorizeTaskGroup(req, res, storage, groupId);
      if (!authorized) return; // 401/404/403 already written
      const ownerId = req.user!.id;
      const body = req.body as z.infer<typeof ExecuteSdlcSchema>;

      try {
        const handle = await service.execute(groupId, ownerId, body.repoPath);
        // 202 Accepted — the coder runs in the background; poll the status route.
        // An already-in-flight run returns its EXISTING handle (deduped:true).
        return res.status(202).json(handle);
      } catch (err) {
        if (err instanceof ExecuteSdlcError) return mapExecuteError(res, groupId, body.repoPath, err);
        return res.status(500).json({ error: "Failed to execute SDLC for this verdict" });
      }
    },
  );

  // GET /api/task-groups/:groupId/execute-sdlc/status — poll the run (every few s).
  app.get(
    "/api/task-groups/:groupId/execute-sdlc/status",
    async (req: Request, res: Response) => {
      const groupId = String(req.params.groupId);
      const authorized = await authorizeTaskGroup(req, res, storage, groupId);
      if (!authorized) return;

      const status = service.getStatus(groupId);
      if (!status) {
        return res.status(404).json({ error: "no execute-sdlc run for this group" });
      }
      return res.status(200).json(status);
    },
  );
}

/**
 * Map a typed {@link ExecuteSdlcError} to an ACTIONABLE 4xx (mirrors the
 * POST /api/consilium-reviews mapping so the two surfaces agree on wording). The
 * NO_REPO / REPO_NOT validation codes map to 400; the MED-1 global-cap code
 * (`EXECUTOR_BUSY`) maps to 429 (transient — retry later). The repoPath is the
 * user's own input, not an fs leak, so we name it.
 */
function mapExecuteError(
  res: Response,
  groupId: string,
  repoPath: string | undefined,
  err: ExecuteSdlcError,
): Response {
  switch (err.code) {
    case "NO_ACTION_POINTS":
      return res.status(400).json({
        error: `no action points to execute: task group "${groupId}" has no consilium verdict with action points yet.`,
      });
    case "NO_REPO_PATH":
      return res.status(400).json({
        error:
          "no repoPath: this task group has no consilium loop to source the repo from — supply a repoPath in the request body (it must be an allowed, project-workspace repo).",
      });
    case "REPO_NOT_WORKSPACE":
      return res.status(400).json({
        error: `repoPath "${repoPath ?? "(from loop)"}" is not registered as a workspace of the selected project — pick one of its workspaces or add it as a workspace.`,
      });
    case "REPO_NOT_ALLOWED":
      return res.status(400).json({
        error: `repoPath "${repoPath ?? "(from loop)"}" is not in the allowed repo paths. Add it to consiliumLoop.allowedRepoPaths in config.yaml (then restart), or pick an already-allowed workspace.`,
      });
    case "EXECUTOR_BUSY":
      // MED-1: global concurrency cap reached — transient, so 429 + Retry-After.
      res.setHeader("Retry-After", "30");
      return res.status(429).json({
        error: "SDLC executor busy — too many concurrent runs, retry shortly.",
      });
    default:
      return res.status(400).json({ error: "execute-sdlc rejected" });
  }
}
