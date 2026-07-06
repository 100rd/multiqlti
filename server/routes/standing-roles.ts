/**
 * standing-roles.ts — the ROLE-1 HTTP surface (standing-role.md §3/§8).
 *
 * A StandingRole is a named, persistent identity — a SAVED COMPOSITION of a persona
 * (standing instruction) + skills + a loop template — that an operator defines once
 * and can manually "WAKE" to spawn ONE ephemeral consilium loop. This file is the
 * project-scoped CRUD (`/api/roles`) plus the manual wake (`/api/roles/:id/wake`).
 *
 * SCOPE (ROLE-1 only): the record + manual wake. NO triggers/concerns binding
 * (ROLE-2) and NO role-scoped experience (ROLE-3) — a wake here is an EXPLICIT
 * user/API action, never a background runtime (a role is a definition, not a
 * process — §6).
 *
 * Auth: the whole router is mounted behind `requireAuth + requireProject` in
 * `routes.ts` (the /api/pr-queue 401 lesson — never a per-route auth to forget), so
 * every handler already runs inside the request's project ALS. Each handler ALSO
 * re-checks `req.user?.id` / `req.projectId` as defense-in-depth (mirrors
 * consilium-reviews.ts). The router is registered ONLY inside the
 * `config.consiliumLoop.enabled` kill-switch block (inert otherwise), same as the
 * consilium-review routes it reuses.
 *
 * WAKE reuses the SINGLE review-launch factory (`createConsiliumReview`) — the SAME
 * code `POST /api/consilium-reviews` uses — so a wake does NOT reimplement loop
 * creation and does NOT touch trigger-dispatch's tracker/spec paths. The factory
 * re-validates `repoPath` against the fail-closed allowlist (S1) + per-project
 * workspace confinement (S5) and re-resolves `skillIds` PROJECT-SCOPED (fail-closed)
 * — the wake trusts NONE of the stored role config blindly.
 *
 * SECURITY (flagged for the adversarial reviewer):
 *   - Wake CANNOT bypass the allowlist: `repoPath` is re-validated INSIDE the factory
 *     (never trusted from the request), same gate as the UI review button.
 *   - Skills are validated against the PROJECT-SCOPED registry at create/update
 *     (fail-closed — unknown id → 400) AND re-resolved by the factory at wake.
 *   - persona + focus are UNTRUSTED at wake: they are joined here and handed to the
 *     factory as `engineerInstruction`, which control-strips + byte-clamps + fences
 *     them (untrustedExtraBlock) before they enter the objective — no injection seam.
 *   - A DISABLED role cannot wake (409 before the factory is ever called — §6).
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { CONSILIUM_REVIEW_PRESETS, REVIEW_MODES } from "@shared/types";
import type { IStorage } from "../storage.js";
import type { InsertStandingRole } from "@shared/schema";
import { validateBody } from "../middleware/validate.js";
import {
  createConsiliumReview,
  type CreateConsiliumReviewDeps,
} from "../services/consilium/review-factory.js";

/** Max skills a role may carry — mirrors the review factory's MAX_REVIEW_SKILLS. */
const MAX_ROLE_SKILLS = 5;

/** The role's loop template — HOW its ephemeral loops run (server enums + bounds). */
const LoopTemplateSchema = z.object({
  preset: z.enum(CONSILIUM_REVIEW_PRESETS),
  maxRounds: z.coerce.number().int().min(1).max(6).optional(),
  reviewMode: z.enum(REVIEW_MODES).optional(),
});

const CreateRoleSchema = z.object({
  name: z.string().min(1).max(200),
  // The standing instruction. Bounded at the same 8000 the review engineerInstruction
  // uses (the factory's OBJECTIVE_EXTRA_MAX_BYTES) so a too-long persona is a clean 400
  // here rather than a silent downstream truncation.
  persona: z.string().min(1).max(8000),
  // Skill ids (<= MAX_ROLE_SKILLS). Existence is validated against the project registry
  // in the handler (fail-closed); the zod cap keeps a >5 body a clean 400.
  skills: z.array(z.string().min(1).max(200)).max(MAX_ROLE_SKILLS).default([]),
  loopTemplate: LoopTemplateSchema,
  enabled: z.boolean().default(true),
});

/** PATCH is a partial of create (every field optional). */
const UpdateRoleSchema = CreateRoleSchema.partial();

/**
 * Wake body: WHERE (repoPath — re-validated fail-closed by the factory) and WHAT to
 * look at (focus — UNTRUSTED, folded into the loop instruction + fenced downstream).
 * The persona/skills/template come from the ROLE, not the request.
 */
const WakeSchema = z.object({
  repoPath: z.string().min(1).max(4096),
  focus: z.string().min(1).max(8000),
});

/**
 * Compose the wake's engineer instruction from the role's persona + the wake focus.
 * PURE (unit-testable). We ONLY JOIN here — the review factory does ALL sanitization:
 * it control-strips + byte-clamps + wraps the whole string in a strictly-longer
 * backtick fence (untrustedExtraBlock) before it enters the objective, so neither the
 * stored persona nor the per-wake focus can break out to inject instructions. The
 * fencing is a SINGLE seam (the factory), not re-done here.
 */
export function composeWakeInstruction(persona: string, focus: string): string {
  return `${persona}\n\n## Focus\n${focus}`;
}

/**
 * Validate that every skill id exists in the PROJECT-SCOPED registry (fail-closed).
 * Returns the FIRST offending id (safe to echo — it is the caller's own input), or
 * null when all resolve. Mirrors the factory's `resolveSkillDirectives` gate so a
 * role can never be SAVED referencing a skill a wake would then reject.
 */
async function firstUnknownSkillId(storage: IStorage, skillIds: readonly string[]): Promise<string | null> {
  for (const id of skillIds) {
    const skill = await storage.getSkill(id);
    if (!skill) return id;
  }
  return null;
}

/**
 * Map a factory error to an actionable 4xx (shared by wake). Mirrors the
 * consilium-reviews route mapping so the allowlist / workspace / skill boundaries
 * surface distinct, fixable messages. Returns true when it handled the response.
 */
function mapFactoryError(err: unknown, repoPath: string, res: Response): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("[skill-not-found]")) {
    res.status(400).json({ error: message.replace("[skill-not-found] ", "") });
    return true;
  }
  if (/is not a workspace of this project/i.test(message)) {
    res.status(400).json({
      error: `repoPath "${repoPath}" is not registered as a workspace of the selected project — pick one of its workspaces or add it as a workspace.`,
    });
    return true;
  }
  if (/allowlist|outside every allowed|denied system|traversal|fail-closed/i.test(message)) {
    res.status(400).json({
      error: `repoPath "${repoPath}" is not in the allowed repo paths. Add it to consiliumLoop.allowedRepoPaths in config.yaml (then restart), or pick an already-allowed workspace.`,
    });
    return true;
  }
  return false;
}

export function registerStandingRoleRoutes(app: Express, deps: CreateConsiliumReviewDeps): void {
  const { storage } = deps;

  // ─── LIST ───────────────────────────────────────────────────────────────
  app.get("/api/roles", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const roles = await storage.getStandingRoles();
    return res.json(roles);
  });

  // ─── CREATE ─────────────────────────────────────────────────────────────
  app.post("/api/roles", validateBody(CreateRoleSchema), async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const body = req.body as z.infer<typeof CreateRoleSchema>;

    // Fail-closed: a role may not be saved referencing a skill that does not exist in
    // THIS project (so a wake can never reference a phantom capability).
    const unknown = await firstUnknownSkillId(storage, body.skills);
    if (unknown) {
      return res.status(400).json({ error: `skill "${unknown}" was not found in this project` });
    }

    const created = await storage.createStandingRole({
      name: body.name,
      persona: body.persona,
      skills: body.skills,
      loopTemplate: body.loopTemplate,
      enabled: body.enabled,
      createdBy: req.user.id,
    } as InsertStandingRole);
    return res.status(201).json(created);
  });

  // ─── GET ONE ────────────────────────────────────────────────────────────
  app.get("/api/roles/:id", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const role = await storage.getStandingRole(String(req.params.id));
    if (!role) return res.status(404).json({ error: "Role not found" });
    return res.json(role);
  });

  // ─── UPDATE ─────────────────────────────────────────────────────────────
  app.patch("/api/roles/:id", validateBody(UpdateRoleSchema), async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const body = req.body as z.infer<typeof UpdateRoleSchema>;

    const existing = await storage.getStandingRole(String(req.params.id));
    if (!existing) return res.status(404).json({ error: "Role not found" });

    if (body.skills !== undefined) {
      const unknown = await firstUnknownSkillId(storage, body.skills);
      if (unknown) {
        return res.status(400).json({ error: `skill "${unknown}" was not found in this project` });
      }
    }

    const updated = await storage.updateStandingRole(String(req.params.id), body as Partial<InsertStandingRole>);
    return res.json(updated);
  });

  // ─── DELETE ─────────────────────────────────────────────────────────────
  app.delete("/api/roles/:id", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const existing = await storage.getStandingRole(String(req.params.id));
    if (!existing) return res.status(404).json({ error: "Role not found" });
    await storage.deleteStandingRole(String(req.params.id));
    return res.status(204).end();
  });

  // ─── WAKE — spawn ONE ephemeral consilium loop from the role ─────────────
  app.post("/api/roles/:id/wake", validateBody(WakeSchema), async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const body = req.body as z.infer<typeof WakeSchema>;

    const role = await storage.getStandingRole(String(req.params.id));
    if (!role) return res.status(404).json({ error: "Role not found" });

    // §6 safety: a role is a definition, not a live process — a DISABLED role can
    // never spawn work. Refuse BEFORE the factory is touched.
    if (!role.enabled) {
      return res.status(409).json({ error: "This role is disabled and cannot be woken. Enable it first." });
    }

    try {
      // Compose the loop payload FROM THE ROLE (standing-role.md §3):
      //   engineerInstruction = persona + focus  (UNTRUSTED — fenced by the factory)
      //   skillIds            = role.skills       (re-resolved fail-closed by the factory)
      //   preset/maxRounds/reviewMode = role.loopTemplate
      // on `repoPath` (re-validated fail-closed against the allowlist by the factory).
      const loop = await createConsiliumReview(deps, {
        projectId: req.projectId,
        repoPath: body.repoPath,
        preset: role.loopTemplate.preset,
        createdBy: req.user.id,
        maxRounds: role.loopTemplate.maxRounds,
        reviewMode: role.loopTemplate.reviewMode,
        engineerInstruction: composeWakeInstruction(role.persona, body.focus),
        skillIds: role.skills,
        // Provenance: record the originating role so a wake is TRACEABLE on the
        // launch passport (a wake is not a trigger fire — no trigger trio, just role).
        triggerProvenance: {
          firedAt: new Date().toISOString(),
          role: { roleId: role.id, name: role.name },
        },
      });
      return res.status(201).json(loop);
    } catch (err) {
      if (mapFactoryError(err, body.repoPath, res)) return;
      // eslint-disable-next-line no-console
      console.error("[roles] wake failed:", err instanceof Error ? err.message : String(err));
      return res.status(500).json({ error: "Failed to wake the role" });
    }
  });
}
