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
import { CONSILIUM_REVIEW_PRESETS, REVIEW_MODES } from "@shared/types";
import { validateBody } from "../middleware/validate.js";
import {
  createConsiliumReview,
  type CreateConsiliumReviewDeps,
} from "../services/consilium/review-factory.js";
import {
  reformulateInstruction,
  MAX_RAW_WANT_LEN,
} from "../services/consilium/reformulate.js";
import { REVIEW_REF_RE, INVALID_REF_MESSAGE } from "../services/consilium/ref-validator.js";
import { sanitizeCommitPrefix } from "./consilium-loops.js";

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
  // ADR-003 §D2: operator-authorized secret NAMES (resolved + bound by the
  // factory, which enforces the identifier shape and 400s an unknown name).
  secretNames: z.array(z.string().min(1).max(64)).max(20).optional(),
  // Single-verifier re-review: OPTIONAL per-loop review mode. Absent ⇒ null ⇒ the
  // server resolves it from the operator default (verifyReview.enabled). A server
  // enum (z.enum) so only the two known values pass; anything else is a clean 400.
  reviewMode: z.enum(REVIEW_MODES).optional(),
  // OPTIONAL per-loop commit-message/MR-title prefix (e.g. a Jira issue key) --
  // sanitized by the SAME sanitizeCommitPrefix helper the loops route uses;
  // empty/whitespace-only is treated as absent (no prefix).
  commitPrefix: z.string().optional(),
});

/**
 * "Magic mode" reformulation body. `rawWant` is the operator's rough request —
 * UNTRUSTED free-text, fenced-as-data by the reformulate service before it reaches
 * the model. `.min(1)` after trim rejects an empty/whitespace-only want with a
 * clean 400 (no wasted model call). The `.trim()` transform means a whitespace-
 * only body fails the min check. `preset` reuses the same enum as create so the
 * reformulator can tailor the instruction to the chosen dispute.
 */
const ReformulateSchema = z.object({
  rawWant: z.string().trim().min(1, "rawWant must not be empty").max(MAX_RAW_WANT_LEN),
  repoPath: z.string().min(1).max(4096),
  preset: z.enum(CONSILIUM_REVIEW_PRESETS),
});

export function registerConsiliumReviewRoutes(app: Express, deps: CreateConsiliumReviewDeps): void {
  // POST /api/consilium-reviews/reformulate-instruction — "magic mode": turn the
  // operator's rough want into a PROPOSED engineer instruction they then review and
  // edit. A single out-of-band gateway call; persists nothing, submits nothing. The
  // whole router is already behind requireAuth + requireProject and the
  // consiliumLoop.enabled kill-switch (registered only then). This endpoint is
  // ADDITIVELY gated by consiliumLoop.reformulate.enabled AND a wired gateway.
  app.post(
    "/api/consilium-reviews/reformulate-instruction",
    validateBody(ReformulateSchema),
    async (req: Request, res: Response) => {
      if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
      if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });

      const cfg = deps.config().pipeline.consiliumLoop;
      // Finer kill-switch: OFF (or no gateway wired) ⇒ magic mode is inert; the UI
      // falls back to manual authoring. 409 so the client can distinguish "disabled"
      // from a transient failure.
      if (!cfg.reformulate?.enabled || !deps.gateway) {
        return res.status(409).json({ error: "Magic-mode reformulation is disabled for this instance." });
      }

      const body = req.body as z.infer<typeof ReformulateSchema>;
      try {
        const { proposedInstruction } = await reformulateInstruction(
          {
            gateway: deps.gateway,
            model: cfg.reformulate.model,
            timeoutMs: deps.config().pipeline.taskGroups.taskTimeoutMs,
          },
          { rawWant: body.rawWant, repoPath: body.repoPath, preset: body.preset },
        );
        return res.status(200).json({ proposedInstruction });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // An empty model reply (or gateway failure) is a transient upstream problem,
        // not the caller's fault — 502. The message is generic (no model internals).
        // eslint-disable-next-line no-console
        console.error("[consilium-reviews] reformulate failed:", message);
        return res.status(502).json({ error: "Could not reformulate the instruction — try again or write it manually." });
      }
    },
  );

  app.post(
    "/api/consilium-reviews",
    validateBody(CreateReviewSchema),
    async (req: Request, res: Response) => {
      if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
      if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
      const body = req.body as z.infer<typeof CreateReviewSchema>;

      // Ticket-first policy (requireTicketRef): refuse an unkeyed manual launch —
      // the team's forge rejects commits without an issue key, so an unkeyed loop
      // could never publish its work anyway. Fail fast with an actionable 400.
      if (
        deps.config?.().pipeline?.consiliumLoop?.requireTicketRef &&
        !sanitizeCommitPrefix(body.commitPrefix)
      ) {
        return res.status(400).json({
          error:
            'ticket key required: fill the Jira issue field (e.g. "PDO-123") — this project requires ticket-linked commits',
        });
      }

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
          // ADR-003 §D2: operator-authorized secrets — resolved + bound by factory.
          secretNames: body.secretNames,
          // Single-verifier re-review: OPTIONAL per-loop mode (persisted on the loop).
          reviewMode: body.reviewMode,
          // OPTIONAL per-loop commit-message/MR-title prefix (sanitized here, same
          // helper + clamp as the /api/consilium-loops create route).
          commitPrefix: sanitizeCommitPrefix(body.commitPrefix),
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
        // ADR-003 §D2: an unknown project secret name, or a malformed/oversized
        // secretNames set. The factory names the offender (the caller's own input,
        // a credential NAME — not secret material and not an fs leak).
        if (message.includes("[secret-not-found]") || message.includes("[secret-invalid]")) {
          return res.status(400).json({
            error: message.replace(/\[secret-(?:not-found|invalid)\] /, ""),
          });
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
