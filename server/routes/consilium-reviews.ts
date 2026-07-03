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
import { REVIEW_REF_RE, INVALID_REF_MESSAGE } from "../services/consilium/ref-validator.js";

const SHA_RE = /^[0-9a-f]{7,64}$/;

const CreateReviewSchema = z.object({
  repoPath: z.string().min(1).max(4096),
  preset: z.enum(CONSILIUM_REVIEW_PRESETS),
  maxRounds: z.coerce.number().int().min(1).max(6).optional(),
  // diff-pr-review baseline — strict hex sha (never a ref); ignored by other presets.
  baselineCommit: z.string().regex(SHA_RE).optional(),
  // BRANCH-targeted review: optional git ref (branch name / revision) to target.
  // SAME strict pattern as the factory's validateReviewRef (REVIEW_REF_RE) so the
  // two can never drift — rejects leading `-`, `..`, `@{`, shell metachars, empty,
  // and >255 chars. Absent ⇒ working-tree HEAD (full back-compat).
  ref: z.string().regex(REVIEW_REF_RE, INVALID_REF_MESSAGE).optional(),
  // Stage 1 (§5): OPTIONAL human "engineer instruction" free-text. UNTRUSTED — the
  // factory control-strips + byte-clamps it (untrustedExtraBlock) before it enters
  // the objective AND persists it inert on the loop. Length cap mirrors the
  // factory's OBJECTIVE_EXTRA_MAX_BYTES (8000) so a too-long body is a clean 400
  // here rather than a silent truncation downstream.
  engineerInstruction: z.string().max(8000).optional(),
  // Stage 2 (skills extend the instruction): OPTIONAL operator-selected skill ids
  // whose directives are APPENDED to the engineerInstruction. Bounded to 5 (>5 is a
  // clean 400 here) and each id length-clamped. The factory resolves them
  // PROJECT-SCOPED — a foreign/unknown id is a 400 naming the offending id.
  skillIds: z.array(z.string().min(1).max(200)).max(5).optional(),
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
          ref: body.ref,
          // Stage 1 (§5): threads to the factory objectiveExtra (sanitized) + persists.
          engineerInstruction: body.engineerInstruction,
          // Stage 2: operator skill ids — resolved + appended by the factory.
          skillIds: body.skillIds,
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
        // Stage 2: an unknown/foreign skill id (the factory resolves skills
        // PROJECT-SCOPED). Surface the factory message VERBATIM — it names the
        // offending id (the caller's own input, not an fs leak) so the failure is
        // actionable ("skill \"<id>\" was not found in this project").
        if (message.includes("[skill-not-found]")) {
          return res.status(400).json({ error: message.replace("[skill-not-found] ", "") });
        }
        // The factory STRICT-validates the optional branch/ref (ref-validator.ts)
        // and throws INVALID_REF_MESSAGE on a bad one — surface a clear 400 (the
        // zod gate above already rejects most, this covers defense-in-depth).
        if (message.includes(INVALID_REF_MESSAGE)) {
          return res.status(400).json({ error: `${INVALID_REF_MESSAGE} (allowed: letters, digits, _ - / . ; no leading -, no "..", max 255).` });
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
