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
import type { ConsiliumLoopController } from "../services/consilium/consilium-loop-controller.js";
import type { AppConfig } from "../config/schema.js";
import { requireRole } from "../auth/middleware.js";
import { validateBody } from "../middleware/validate.js";
import { authorizeConsiliumLoop } from "./authorize-consilium-loop.js";
import { isVisible } from "./authorize-run.js";
import { assertAllowedRepoPath } from "../services/consilium/repo-allowlist.js";

const SHA_RE = /^[0-9a-f]{7,64}$/;

const CreateLoopSchema = z.object({
  groupId: z.string().min(1),
  repoPath: z.string().min(1),
  devPipelineId: z.string().min(1).optional(),
  maxRounds: z.coerce.number().int().min(1).max(6).optional(),
  // H-2: a baseline supplied at create time MUST be a strict hex sha (no refs).
  lastReviewedCommit: z.string().regex(SHA_RE).optional(),
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

      const devPipelineId = body.devPipelineId ?? cfg.devPipelineId;
      if (!devPipelineId) {
        return res.status(400).json({ error: "no DEV pipeline configured (body or config)" });
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
          devPipelineId,
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
    const isAdmin = req.user?.role === "admin";
    res.json({ ...maskLoop({ ...auth.loop }, !!isAdmin), rounds });
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

  // ── Cancel (any non-terminal → CANCELLED) ───────────────────────────────────
  app.post("/api/consilium-loops/:id/cancel", async (req: Request, res: Response) => {
    const auth = await authorizeConsiliumLoop(req, res, storage, String(req.params.id));
    if (!auth) return;
    const loop = await controller.cancel(auth.loop.id);
    if (!loop) return res.status(409).json({ error: "loop is already terminal" });
    res.json(loop);
  });
}
