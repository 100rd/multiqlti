/**
 * consilium-reviews.ts — POST /api/consilium-reviews.
 *
 * The HTTP surface the UI "New consilium review" button calls. It is the thin,
 * project-scoped wrapper around the reusable `createConsiliumReview` factory: it
 * validates the body, then delegates the WHOLE assembly (5-task cross-review DAG
 * + loop create + start) to the factory, which RE-VALIDATES the repoPath against
 * the same fail-closed allowlist the consilium-loop create route uses.
 *
 * Auth: mounted behind `requireAuth + requireProject` in `routes.ts`, so the
 * handler already runs inside the request's project ALS context — the factory's
 * `createTaskGroup` / `createLoop` inherit it (no explicit `runAsProject`). The
 * whole router is INERT unless `config.consiliumLoop.enabled` (registered only
 * inside the kill-switch block, same as the consilium-loop routes).
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { CONSILIUM_REVIEW_PRESETS } from "@shared/types";
import { validateBody } from "../middleware/validate.js";
import {
  createConsiliumReview,
  type CreateConsiliumReviewDeps,
} from "../services/consilium/review-factory.js";

const SHA_RE = /^[0-9a-f]{7,64}$/;

const CreateReviewSchema = z.object({
  repoPath: z.string().min(1).max(4096),
  preset: z.enum(CONSILIUM_REVIEW_PRESETS),
  maxRounds: z.coerce.number().int().min(1).max(6).optional(),
  // diff-pr-review baseline — strict hex sha (never a ref); ignored by other presets.
  baselineCommit: z.string().regex(SHA_RE).optional(),
});

export function registerConsiliumReviewRoutes(app: Express, deps: CreateConsiliumReviewDeps): void {
  app.post(
    "/api/consilium-reviews",
    validateBody(CreateReviewSchema),
    async (req: Request, res: Response) => {
      if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
      if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
      const body = req.body as z.infer<typeof CreateReviewSchema>;

      try {
        const loop = await createConsiliumReview(deps, {
          projectId: req.projectId,
          repoPath: body.repoPath,
          preset: body.preset,
          createdBy: req.user.id,
          maxRounds: body.maxRounds,
          baselineCommit: body.baselineCommit,
        });
        return res.status(201).json(loop);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The factory re-validates repoPath against the allowlist; surface an
        // ACTIONABLE 400 that names the rejected path + how to fix it, rather than
        // an opaque "invalid" (the path is the user's own input, not an fs leak).
        if (/baselineCommit/i.test(message)) {
          return res.status(400).json({ error: "baselineCommit must be a 7–64 char hex commit SHA" });
        }
        // MED-3: the factory applies TWO boundaries — the GLOBAL allowlist (S1)
        // and a per-project WORKSPACE confinement (S5). Distinguish them so the
        // 400 tells the user WHICH boundary they hit. Order: workspace first (its
        // distinct `is not a workspace of this project` substring does not overlap
        // the allowlist regex below).
        if (/is not a workspace of this project/i.test(message)) {
          return res.status(400).json({
            error: `repoPath "${body.repoPath}" is not registered as a workspace of the selected project — pick one of its workspaces or add it as a workspace.`,
          });
        }
        if (/allowlist|outside every allowed|denied system|traversal|fail-closed/i.test(message)) {
          return res.status(400).json({
            error: `repoPath "${body.repoPath}" is not in the allowed repo paths. Add it to consiliumLoop.allowedRepoPaths in config.yaml (then restart), or pick an already-allowed workspace.`,
          });
        }
        return res.status(500).json({ error: "Failed to create consilium review" });
      }
    },
  );
}
