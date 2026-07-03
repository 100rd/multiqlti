/**
 * consilium-loops.ts — B.5 HTTP surface for the consilium loop (design §7).
 *
 * All routes are owner-scoped via `authorizeConsiliumLoop` (M-1: 404 on owner
 * mismatch). The create route validates `repoPath` against the fail-closed
 * allowlist and enforces ONE active loop per group (H-3). The merge-approved
 * route is the autonomy→production boundary and is gated with
 * `requireRole("maintainer","admin")` PLUS loop visibility — owner-alone is
 * DENIED (B-2, separation of duties).
 *
 * The whole router is INERT unless `config.consiliumLoop.enabled` — `routes.ts`
 * only registers it (and the poller) behind the kill-switch.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage.js";
import type {
  ConsiliumLoopController,
  DevelopErrorCode,
  PlanErrorCode,
} from "../services/consilium/consilium-loop-controller.js";
import { ARCHETYPES } from "@shared/types";
import { CONSILIUM_LOOP_TERMINAL_STATES } from "@shared/schema";
import { computeOpenRemainder } from "@shared/consilium-remainder";
import type { AppConfig } from "../config/schema.js";
import { requireRole } from "../auth/middleware.js";
import { validateBody } from "../middleware/validate.js";
import { authorizeConsiliumLoop } from "./authorize-consilium-loop.js";
import { isVisible } from "./authorize-run.js";
import { assertAllowedRepoPath } from "../services/consilium/repo-allowlist.js";
import {
  buildLoopComposition,
  parseConsiliumPreset,
  type LoopComposition,
} from "../services/consilium/composition.js";

const SHA_RE = /^[0-9a-f]{7,64}$/;

const CreateLoopSchema = z.object({
  groupId: z.string().min(1),
  repoPath: z.string().min(1),
  maxRounds: z.coerce.number().int().min(1).max(6).optional(),
  // H-2: a baseline supplied at create time MUST be a strict hex sha (no refs).
  lastReviewedCommit: z.string().regex(SHA_RE).optional(),
});

// Stage 1 (§6): the human archetype OVERRIDE body — enum-clamped (no model call).
/** Max stored cancellation reason (truncated, not rejected — see `sanitizeReason`). */
const MAX_CANCEL_REASON = 500;

/**
 * Cancel body is OPTIONAL — an auto-cancel is a POST with no/empty body. A
 * present `reason` is untrusted free text, sanitized downstream; a non-string
 * `reason` is a 400. `.passthrough()` is deliberately NOT used.
 */
const CancelLoopSchema = z.object({
  reason: z.string().optional(),
});

/**
 * Sanitize an untrusted cancellation reason: control-strip (C0/DEL/C1),
 * collapse whitespace, trim, then CLAMP (not reject) to {@link MAX_CANCEL_REASON}.
 * Returns undefined for a non-string or empty-after-strip input so the composed
 * explanation falls back to the actor+timestamp form (never blank).
 */
function sanitizeReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CANCEL_REASON);
  return cleaned.length ? cleaned : undefined;
}

const ArchetypeOverrideSchema = z.object({
  archetype: z.enum(ARCHETYPES),
});

/** Mask the loop row for non-admins: hide createdBy attribution. */
function maskLoop(loop: Record<string, unknown>, isAdmin: boolean): Record<string, unknown> {
  if (isAdmin) return loop;
  const { createdBy: _omit, ...rest } = loop;
  return rest;
}

export function registerConsiliumLoopRoutes(
  app: Express,
  storage: IStorage,
  controller: ConsiliumLoopController,
  config: () => AppConfig,
): void {
  // ── Create ────────────────────────────────────────────────────────────────
  app.post(
    "/api/consilium-loops",
    validateBody(CreateLoopSchema),
    async (req: Request, res: Response) => {
      if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
      const body = req.body as z.infer<typeof CreateLoopSchema>;
      const cfg = config().pipeline.consiliumLoop;

      // The caller may only loop over a group they can see (no cross-owner loop).
      const group = await storage.getTaskGroup(body.groupId);
      if (!group) return res.status(404).json({ error: "Task group not found" });
      if (!isVisible(group.createdBy, req.user)) {
        return res.status(404).json({ error: "Task group not found" });
      }

      // H-1: repoPath must resolve inside the fail-closed allowlist.
      try {
        assertAllowedRepoPath(body.repoPath, cfg.allowedRepoPaths);
      } catch {
        return res.status(400).json({ error: "repoPath is not in the configured allowlist" });
      }

      // H-3: reject a 2nd active loop on the same group (app-level pre-check; the
      // DB partial-unique index is the authoritative backstop on a create race).
      const active = await storage.getActiveLoopByGroup(body.groupId);
      if (active) {
        return res.status(409).json({ error: "an active loop already exists for this group" });
      }

      try {
        const loop = await storage.createLoop({
          groupId: body.groupId,
          repoPath: body.repoPath,
          maxRounds: body.maxRounds ?? cfg.maxRounds,
          lastReviewedCommit: body.lastReviewedCommit ?? null,
          createdBy: req.user.id,
        });
        return res.status(201).json(loop);
      } catch (err) {
        // The partial-unique violation surfaces here under a create race.
        if (err instanceof Error && err.message.includes("one_active_per_group")) {
          return res.status(409).json({ error: "an active loop already exists for this group" });
        }
        return res.status(500).json({ error: "Failed to create loop" });
      }
    },
  );

  // ── List (owner-scoped, metadata only) ──────────────────────────────────────
  app.get("/api/consilium-loops", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    const isAdmin = req.user.role === "admin";
    const loops = isAdmin ? await storage.getLoops() : await storage.getLoopsByOwner(req.user.id);
    res.json(loops.map((l) => maskLoop({ ...l }, isAdmin)));
  });

  // ── Detail (+ rounds) ───────────────────────────────────────────────────────
  app.get("/api/consilium-loops/:id", async (req: Request, res: Response) => {
    const auth = await authorizeConsiliumLoop(req, res, storage, String(req.params.id));
    if (!auth) return;
    const rounds = await storage.getLoopRounds(auth.loop.id);
    // Display-only per-AP progress of the loop's DEVELOPING phase (process-local,
    // ephemeral — degrades to undefined cross-instance; DB state stays authoritative).
    const devProgress = controller.getDevProgress(auth.loop.id);
    const isAdmin = req.user?.role === "admin";
    // Finding #5: for a TERMINAL loop, surface a READ-TIME count-by-priority of
    // the LAST round's still-open action points so a "converged with remainder"
    // outcome (convergence keys on P0 by design; non-P0 items still standing) is
    // visible + executable via develop-from-terminal. Computed here from the
    // already-fetched `rounds` — no schema change; `undefined` (omitted from the
    // JSON) for a non-terminal loop or an empty last round.
    const openRemainder = (CONSILIUM_LOOP_TERMINAL_STATES as readonly string[]).includes(
      auth.loop.state,
    )
      ? computeOpenRemainder(rounds)
      : undefined;
    // Stage 1: the new loop columns (engineerInstruction, archetype, archetypeSource,
    // archetypeRationale, archetypeParams, archetypeDecidedAt) ride the maskLoop
    // spread of `auth.loop` automatically — no per-field allowlist to keep in sync.
    //
    // Observability (GAP 2): the computed `composition` — WHICH models/tools fill
    // each role (debaters + judge from the review-factory preset panel, planner,
    // judge-retry fallback, SDLC coder, Stage-B verifier) + the active verification
    // config. Read-only, additive, and a strict NAME/BOOLEAN allowlist (never a
    // secret — see composition.ts). The preset is recovered from the group NAME;
    // the whole block is best-effort: any read failure (or a partial config) omits
    // it rather than breaking the GET (parity with `devProgress`).
    let composition: LoopComposition | undefined;
    try {
      const group =
        typeof storage.getTaskGroup === "function"
          ? await storage.getTaskGroup(auth.loop.groupId)
          : undefined;
      const preset = parseConsiliumPreset(group?.name);
      composition = buildLoopComposition(preset, config());
    } catch {
      composition = undefined;
    }
    res.json({
      ...maskLoop({ ...auth.loop }, !!isAdmin),
      rounds,
      devProgress,
      openRemainder,
      composition,
    });
  });

  // ── Start (PENDING → BUILDING_CONTEXT) ──────────────────────────────────────
  app.post("/api/consilium-loops/:id/start", async (req: Request, res: Response) => {
    const auth = await authorizeConsiliumLoop(req, res, storage, String(req.params.id));
    if (!auth) return;
    if (auth.loop.state !== "pending") {
      return res.status(409).json({ error: "loop is not PENDING" });
    }
    const loop = await controller.start(auth.loop.id);
    if (!loop) return res.status(409).json({ error: "loop could not be started" });
    res.json(loop);
  });

  // ── Merge-approved (HITL gate) — B-2: maintainer/admin ONLY + visibility ────
  app.post(
    "/api/consilium-loops/:id/merge-approved",
    requireRole("maintainer", "admin"),
    async (req: Request, res: Response) => {
      // requireRole already rejected non-maintainer/admin (incl. a plain owner).
      const auth = await authorizeConsiliumLoop(req, res, storage, String(req.params.id));
      if (!auth) return;
      if (auth.loop.state !== "awaiting_merge") {
        return res.status(409).json({ error: "loop is not AWAITING_MERGE" });
      }
      // M-3: the merged HEAD is read SERVER-side (never a client-supplied sha).
      const merged = await controller.onMergeApproved(auth.loop.id, "");
      if (!merged) return res.status(409).json({ error: "merge approval could not be applied" });
      res.json(merged);
    },
  );

  // ── Develop (HUMAN re-open of a verdict-terminal loop → DEVELOPING) ──────────
  // Auth = owner-or-admin (`authorizeConsiliumLoop`, 404-on-mismatch) — NOT the
  // stricter maintainer/admin merge gate. This re-opens a terminal verdict-loop to
  // implement its action points (parity with the removed "execute verdict" button);
  // the autonomy→production boundary stays the merge-approved gate above. The whole
  // controller is INERT outside the kill-switch (routes.ts only registers it then).
  app.post("/api/consilium-loops/:id/develop", async (req: Request, res: Response) => {
    const auth = await authorizeConsiliumLoop(req, res, storage, String(req.params.id));
    if (!auth) return;
    const result = await controller.develop(auth.loop.id);
    if (result.ok) {
      const isAdmin = req.user?.role === "admin";
      // 200 + the masked loop row (state is now "developing"); the client polls
      // GET /api/consilium-loops/:id (which now carries devProgress) to observe it.
      return res.json(maskLoop({ ...result.loop }, !!isAdmin));
    }
    return mapDevelopError(res, result.code);
  });

  // ── Plan (Stage 1 §6: OUT-OF-BAND intent→archetype planner) ─────────────────
  // Owner-or-admin (authorizeConsiliumLoop, 404-on-mismatch). Idempotent: a no-op
  // returning the existing archetype unless `?replan=1`. NO_VERDICT (409) when the
  // loop has no readable judge verdict. A single lightweight model call (NOT a DAG
  // task / FSM state); it writes the archetype columns via a PLAIN partial update
  // and so never transitions a terminal loop. FAIL-SOFT: a bad/unparseable model
  // reply yields 200 with archetype null (the column stays null).
  app.post("/api/consilium-loops/:id/plan", async (req: Request, res: Response) => {
    const auth = await authorizeConsiliumLoop(req, res, storage, String(req.params.id));
    if (!auth) return;
    const replan = req.query.replan === "1" || req.query.replan === "true";
    const result = await controller.plan(auth.loop.id, { replan });
    if (result.ok) {
      const isAdmin = req.user?.role === "admin";
      return res.json({
        ...maskLoop({ ...result.loop }, !!isAdmin),
        // Echo what the planner produced this call (null = ran but no usable archetype).
        plannedArchetype: result.archetype,
      });
    }
    return mapPlanError(res, result.code);
  });

  // ── Archetype override (Stage 1 §6: human sets archetype, NO model call) ─────
  // Owner-or-admin. Sets archetype + archetype_source='override' + decided_at via a
  // PLAIN partial update (never a transition); a later planner run will NOT clobber
  // an override. Body enum-clamped to ARCHETYPES.
  app.patch(
    "/api/consilium-loops/:id/archetype",
    validateBody(ArchetypeOverrideSchema),
    async (req: Request, res: Response) => {
      const auth = await authorizeConsiliumLoop(req, res, storage, String(req.params.id));
      if (!auth) return;
      const body = req.body as z.infer<typeof ArchetypeOverrideSchema>;
      const result = await controller.setArchetype(auth.loop.id, body.archetype);
      if (!result.ok) return res.status(404).json({ error: "Consilium loop not found" });
      const isAdmin = req.user?.role === "admin";
      return res.json(maskLoop({ ...result.loop }, !!isAdmin));
    },
  );

  // ── Cancel (any non-terminal → CANCELLED) ───────────────────────────────────
  // Body is OPTIONAL: `{ reason?: string }` (untrusted → sanitized + clamped).
  // The acting user is resolved from the authorized session (never client-set),
  // so the recorded terminal explanation names a real actor, never "system"
  // unless truly unresolvable.
  app.post("/api/consilium-loops/:id/cancel", async (req: Request, res: Response) => {
    const auth = await authorizeConsiliumLoop(req, res, storage, String(req.params.id));
    if (!auth) return;
    // Tolerate a missing/empty body (auto-cancel POSTs carry none); only a
    // present-but-wrong-typed `reason` is a 400.
    const parsed = CancelLoopSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const reason = sanitizeReason(parsed.data.reason);
    const actor = req.user?.name?.trim() || req.user?.email || req.user?.id || undefined;
    const loop = await controller.cancel(auth.loop.id, { reason, actor });
    if (!loop) return res.status(409).json({ error: "loop is already terminal" });
    res.json(loop);
  });
}

/**
 * Map a typed {@link DevelopErrorCode} to an actionable HTTP status. Conflicts
 * (wrong state / active loop / lost CAS) → 409; validation (no action points /
 * repo gate) → 400; the R1 global concurrency cap → 429 (transient, Retry-After);
 * a vanished loop → 404. Mirrors the merge-approved/create wording.
 */
function mapDevelopError(res: Response, code: DevelopErrorCode): Response {
  switch (code) {
    case "WRONG_STATE":
      return res.status(409).json({
        error: "loop is not in a developable terminal state (converged / stopped_cap / escalated)",
      });
    case "ACTIVE_LOOP_EXISTS":
      return res.status(409).json({ error: "an active loop already exists for this group" });
    case "CAS_LOST":
      return res.status(409).json({ error: "develop could not be applied (concurrent update)" });
    case "BUSY":
      res.setHeader("Retry-After", "30");
      return res.status(429).json({
        error: "SDLC executor busy — too many concurrent dev runs, retry shortly.",
      });
    case "NO_ACTION_POINTS":
      return res
        .status(400)
        .json({ error: "no action points to develop: this loop's verdict has no action points." });
    case "REPO_NOT_WORKSPACE":
      return res
        .status(400)
        .json({ error: "the loop's repoPath is not a registered workspace of this project." });
    case "REPO_NOT_ALLOWED":
      return res
        .status(400)
        .json({ error: "the loop's repoPath is not in the configured allowlist." });
    case "NOT_FOUND":
      return res.status(404).json({ error: "Consilium loop not found" });
    default:
      return res.status(400).json({ error: "develop rejected" });
  }
}

/**
 * Map a typed {@link PlanErrorCode} to HTTP. Disabled planner / no readable verdict
 * → 409 (a conflict with the loop's current state); a vanished loop → 404.
 */
function mapPlanError(res: Response, code: PlanErrorCode): Response {
  switch (code) {
    case "PLANNER_DISABLED":
      return res.status(409).json({ error: "the intent planner is disabled" });
    case "NO_VERDICT":
      return res
        .status(409)
        .json({ error: "no readable verdict to plan from: run/await the consilium review first." });
    case "NOT_FOUND":
      return res.status(404).json({ error: "Consilium loop not found" });
    default:
      return res.status(400).json({ error: "plan rejected" });
  }
}
