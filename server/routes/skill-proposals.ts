/**
 * skill-proposals.ts — DREAM-4 HTTP surface: the HUMAN/CODEOWNERS review gate for
 * Experience → SKILL.md feedback proposals.
 * Spec: docs/design/experience-plane-dream.md §5 (Experience ≠ Skill — the patch path is
 * CODEOWNERS-gated, a human owns the decision), §9 (DREAM-4).
 *
 * TWO routes, both project-scoped (mounted behind requireAuth + requireProject in routes.ts):
 *   - GET  /api/skill-proposals            — list proposals (optionally ?status=), read-only.
 *   - PATCH /api/skill-proposals/:id        — MOVE a proposal's trust-envelope status. This is
 *     the HUMAN GATE: gated `requireRole("maintainer","admin")` (CODEOWNERS — separation of
 *     duties, like the loop's merge-approved boundary). DREAM-4's background proposer NEVER
 *     hits this route; only a human does. The allowed moves are a fixed transition map — a
 *     proposal can NEVER be auto-graduated, and an illegal move is a 400.
 *
 * The whole router is INERT unless `experiencePlane.skillFeedback.enabled` — routes.ts only
 * mounts it behind the kill-switch (default off ⇒ byte-identical, no review surface).
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage.js";
import { SKILL_PROPOSAL_STATUS_VALUES, type SkillProposalStatus } from "@shared/types";
import { requireRole } from "../auth/middleware.js";
import { validateBody } from "../middleware/validate.js";

/** Max stored review note (truncated, not rejected). */
const MAX_REVIEW_NOTE = 500;

/**
 * The ALLOWED trust-envelope transitions a HUMAN reviewer may make (§5, ADR-0002). The
 * proposer only ever CREATES `unverified`; every move here is a human decision:
 *   - `unverified` → `verified`  (GRADUATE — the patch was reused and its success-delta held)
 *   - `unverified` → `rejected`  (DECLINE — a bad/opinion pattern)
 *   - `verified`   → `deprecated`(a once-verified patch that stopped working — self-correction)
 *   - `verified`   → `rejected`  (retract a graduation)
 * Any other move (including a no-op or resurrecting a `rejected`/`deprecated`) is a 400. There
 * is deliberately NO transition that a machine could take automatically — the whole point.
 */
const ALLOWED_TRANSITIONS: Record<SkillProposalStatus, SkillProposalStatus[]> = {
  unverified: ["verified", "rejected"],
  verified: ["deprecated", "rejected"],
  rejected: [],
  deprecated: [],
};

const ReviewSchema = z.object({
  status: z.enum(SKILL_PROPOSAL_STATUS_VALUES),
  reviewNote: z.string().max(MAX_REVIEW_NOTE).optional(),
});

const ListQuerySchema = z.object({
  status: z.enum(SKILL_PROPOSAL_STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Control-strip + clamp an untrusted review note. */
function sanitizeNote(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_REVIEW_NOTE ? cleaned.slice(0, MAX_REVIEW_NOTE) : cleaned;
}

export function registerSkillProposalRoutes(app: Express, storage: IStorage): void {
  // List — read-only, any authenticated project member.
  app.get("/api/skill-proposals", async (req: Request, res: Response) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      return;
    }
    const proposals = await storage.listSkillProposals({
      status: parsed.data.status,
      limit: parsed.data.limit,
    });
    res.json({ proposals });
  });

  // Review — the HUMAN GATE. maintainer/admin only (CODEOWNERS; separation of duties).
  app.patch(
    "/api/skill-proposals/:id",
    requireRole("maintainer", "admin"),
    validateBody(ReviewSchema),
    async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const { status, reviewNote } = req.body as z.infer<typeof ReviewSchema>;

      const existing = (await storage.listSkillProposals({ limit: 500 })).find((p) => p.id === id);
      if (!existing) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }

      const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(status)) {
        res.status(400).json({
          error: `Illegal transition ${existing.status} → ${status}`,
          allowed,
        });
        return;
      }

      const updated = await storage.updateSkillProposalStatus(id, status, sanitizeNote(reviewNote) ?? null);
      if (!updated) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }
      res.json({ proposal: updated });
    },
  );
}
