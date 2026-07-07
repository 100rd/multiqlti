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
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { CONSILIUM_REVIEW_PRESETS, REVIEW_MODES, STANDING_ROLE_DEFINITION_VERSION } from "@shared/types";
import type {
  StandingRoleConcern,
  StandingRoleDefinition,
  TriggerConfig,
  TriggerType,
} from "@shared/types";
import type { IStorage } from "../storage.js";
import type { InsertStandingRole, StandingRoleRow } from "@shared/schema";
import { computeRoleGraduation } from "../services/consilium/role-track-record.js";
import { validateBody } from "../middleware/validate.js";
import {
  createConsiliumReview,
  type CreateConsiliumReviewDeps,
} from "../services/consilium/review-factory.js";
// ROLE-2: the compose seam moved to a shared pure helper (role-compose.ts) so the
// manual wake (here) and the trigger wake (trigger-dispatch.ts) cannot drift. Re-export
// keeps `composeWakeInstruction`'s existing import path/tests intact.
import { composeWakeInstruction } from "../services/consilium/role-compose.js";
export { composeWakeInstruction };

/** Max skills a role may carry — mirrors the review factory's MAX_REVIEW_SKILLS. */
const MAX_ROLE_SKILLS = 5;

/** The role's loop template — HOW its ephemeral loops run (server enums + bounds). */
const LoopTemplateSchema = z.object({
  preset: z.enum(CONSILIUM_REVIEW_PRESETS),
  maxRounds: z.coerce.number().int().min(1).max(6).optional(),
  reviewMode: z.enum(REVIEW_MODES).optional(),
});

/**
 * ROLE-2 (standing-role.md §6, loop-triggers.md §4): the per-role rails. Bounds only —
 * an omitted field falls back to the server default constant in role-wake.ts. `enabled`
 * (below) stays the primary kill-switch; this is the quantitative budget/cascade rails.
 */
const PolicySchema = z.object({
  budgetPerDay: z.coerce.number().int().min(1).max(1000).optional(),
  cascadeDepth: z.coerce.number().int().min(1).max(20).optional(),
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
  // ROLE-2: the per-role rails. Concerns are NOT set here — they are managed via the
  // dedicated concern endpoints (which also materialise the backing trigger).
  policy: PolicySchema.optional(),
  enabled: z.boolean().default(true),
});

/** file_change concern filter — the watched path + optional glob patterns. */
const FileChangeConcernFilterSchema = z.object({
  watchPath: z.string().min(1).max(4096),
  patterns: z.array(z.string().min(1).max(500)).max(50).optional(),
});

/** github_event concern filter — the polled repo + event set + optional ref filter. */
const GitHubConcernFilterSchema = z.object({
  repository: z.string().min(1).max(200),
  events: z.array(z.string().min(1).max(50)).max(20).optional(),
  refFilter: z.string().min(1).max(300).optional(),
});

/** `owner/repo` — the conservative GitHub name charset the pollers accept (no flag). */
const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * TRACK-6 (task-tracker-triggers.md §5): tracker_event concern filter — the role's
 * INBOX is a tracker project. Only `tracker: "github"` is accepted today (the stamped
 * reference path); the concern's own `repoPath` is the `targetRepoPath` (allowlisted
 * local repo the spec PR lands in — re-validated by the poller). The `label` is the
 * consent-to-intake gate the poller requires at fire time.
 */
const TrackerConcernFilterSchema = z.object({
  tracker: z.literal("github"),
  repo: z.string().regex(OWNER_REPO_RE, "repo must be owner/repo").max(200),
  label: z.string().min(1).max(100),
});

/**
 * ROLE-2 (standing-role.md §3/§8): a concern to ADD to a role. `repoPath` is
 * re-validated fail-closed by the factory at wake (not here). `focus` is UNTRUSTED —
 * fenced by the factory. The `trigger` is a file_change | github_event | tracker_event
 * discriminated union. TRACK-6 adds `tracker_event` (github only) — a role whose INBOX
 * is a tracker project; the labelled ticket crystallises a spec STAMPED with the role.
 */
/** The concern's trigger union — shared by add-concern AND import (identical bounds). */
const ConcernTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file_change"), filter: FileChangeConcernFilterSchema }),
  z.object({ type: z.literal("github_event"), filter: GitHubConcernFilterSchema }),
  z.object({ type: z.literal("tracker_event"), filter: TrackerConcernFilterSchema }),
]);

const AddConcernSchema = z.object({
  repoPath: z.string().min(1).max(4096),
  focus: z.string().min(1).max(8000),
  enabled: z.boolean().optional(),
  trigger: ConcernTriggerSchema,
});

/**
 * ROLE-4 (standing-role.md §8): the portable-definition body `POST /api/roles/import`
 * accepts. Mirrors `StandingRoleDefinition`. Skills travel by NAME (re-resolved against
 * the TARGET registry, fail-closed). `id`/`projectId`/`createdBy`/`triggerId` are NOT
 * accepted — identity/runtime is minted fresh by the import (an incoming `enabled` is
 * IGNORED: import always creates DISABLED, §6). Same bounds as create/add-concern so an
 * oversized/foreign definition is a clean 400, never a downstream truncation.
 */
const ImportRoleSchema = z.object({
  kind: z.literal("standing-role-definition"),
  schemaVersion: z.number().int(),
  // exportedAt is informational — accepted but not trusted (bounded to a sane length).
  exportedAt: z.string().max(64).optional(),
  name: z.string().min(1).max(200),
  persona: z.string().min(1).max(8000),
  skills: z.array(z.object({ name: z.string().min(1).max(200) })).max(MAX_ROLE_SKILLS).default([]),
  loopTemplate: LoopTemplateSchema,
  policy: PolicySchema.nullish(),
  concerns: z
    .array(
      z.object({
        repoPath: z.string().min(1).max(4096),
        focus: z.string().min(1).max(8000),
        enabled: z.boolean().optional(),
        trigger: ConcernTriggerSchema,
      }),
    )
    .max(50)
    .default([]),
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
 * ROLE-4 export: map a role's stored skill IDS → portable NAMES (the SKILL.md slug —
 * the only cross-project-stable key; a UUID is meaningless elsewhere). A skill id that
 * no longer resolves (a since-deleted skill) is DROPPED from the portable definition —
 * it is already a dangling reference, and export must never leak an opaque local id as a
 * "name" (that would fail-closed on import in a confusing way). Returns { names, dropped }.
 */
async function skillIdsToPortableNames(
  storage: IStorage,
  skillIds: readonly string[],
): Promise<{ names: string[]; dropped: number }> {
  const names: string[] = [];
  let dropped = 0;
  for (const id of skillIds) {
    const skill = await storage.getSkill(id);
    if (skill?.name) names.push(skill.name);
    else dropped += 1;
  }
  return { names, dropped };
}

/**
 * ROLE-4 import: re-resolve portable skill NAMES against the TARGET project's registry,
 * FAIL-CLOSED. Returns the resolved local ids OR the FIRST offending name (safe to echo
 * — it is the caller's own input). This is the import trust gate: an imported role can
 * NEVER reference a capability the target project lacks (adversarial: "import trusting
 * unvalidated skills"). Name is the join key; the first registry match by name wins.
 */
async function resolveSkillNames(
  storage: IStorage,
  names: readonly string[],
): Promise<{ ids: string[] } | { unknownName: string }> {
  if (names.length === 0) return { ids: [] };
  const registry = await storage.getSkills();
  const byName = new Map<string, string>();
  for (const s of registry) {
    if (!byName.has(s.name)) byName.set(s.name, s.id);
  }
  const ids: string[] = [];
  for (const name of names) {
    const id = byName.get(name);
    if (!id) return { unknownName: name };
    ids.push(id);
  }
  return { ids };
}

/**
 * ROLE-4 export: render a StandingRole row → its PORTABLE definition (standing-role.md
 * §8). Emits DEFINITION only — persona/skills(by name)/loopTemplate/policy/concerns —
 * and DELIBERATELY OMITS all runtime/identity/secret state: `id`, `projectId`,
 * `createdBy`, timestamps, the role's live `enabled`, and every concern's `id` +
 * backing `triggerId`. (A concern's `id`/`triggerId` are per-project runtime rows; a
 * fresh import mints its own.) Nothing here can wake work or leak a secret — it is a
 * spec, not a session.
 */
async function roleToDefinition(
  storage: IStorage,
  role: StandingRoleRow,
): Promise<{ definition: StandingRoleDefinition; skillsDropped: number }> {
  const { names, dropped } = await skillIdsToPortableNames(storage, role.skills ?? []);
  const concerns = ((role.concerns ?? []) as StandingRoleConcern[]).map((c) => ({
    repoPath: c.repoPath,
    focus: c.focus,
    trigger: c.trigger,
    ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
  }));
  const definition: StandingRoleDefinition = {
    kind: "standing-role-definition",
    schemaVersion: STANDING_ROLE_DEFINITION_VERSION,
    exportedAt: new Date().toISOString(),
    name: role.name,
    persona: role.persona,
    skills: names.map((name) => ({ name })),
    loopTemplate: role.loopTemplate,
    policy: role.policy ?? null,
    concerns,
  };
  return { definition, skillsDropped: dropped };
}

/**
 * ROLE-2/ROLE-4: build a concern (fresh id) + MATERIALISE its backing trigger, returning
 * the concern with its `triggerId` set. Shared by the add-concern endpoint AND import so
 * the trigger-wiring can never drift between the two paths. The backing trigger's
 * `enabled` mirrors the concern; the ROLE's own `enabled` is the master gate the dispatch
 * checks first (a disabled role never wakes — verified in trigger-dispatch), so an
 * imported concern is doubly inert until a human enables the (disabled-on-import) role.
 */
async function materializeConcern(
  storage: IStorage,
  roleId: string,
  input: { repoPath: string; focus: string; trigger: StandingRoleConcern["trigger"]; enabled?: boolean },
): Promise<StandingRoleConcern> {
  const concern: StandingRoleConcern = {
    id: randomUUID(),
    repoPath: input.repoPath,
    focus: input.focus,
    trigger: input.trigger,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
  const { type, config } = buildConcernTriggerConfig(concern, roleId);
  const trigger = await storage.createTrigger({
    type,
    config,
    enabled: concern.enabled !== false,
  } as Parameters<IStorage["createTrigger"]>[0]);
  concern.triggerId = trigger.id;
  return concern;
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

/**
 * ROLE-2: build the BACKING trigger's `config` for a concern — the concern's filter
 * fields (so the existing file-watcher / github poller runtime picks it up) PLUS the
 * `roleConcern` binding the dispatch reads to route the fire to the role-wake path. No
 * `action` is set — a role-bound trigger's behaviour comes ENTIRELY from the role.
 */
function buildConcernTriggerConfig(
  concern: StandingRoleConcern,
  roleId: string,
): { type: TriggerType; config: TriggerConfig } {
  const binding = { roleId, concernId: concern.id };
  if (concern.trigger.type === "file_change") {
    const f = concern.trigger.filter as { watchPath: string; patterns?: string[] };
    return {
      type: "file_change",
      config: {
        watchPath: f.watchPath,
        patterns: f.patterns ?? [],
        roleConcern: binding,
      } as TriggerConfig,
    };
  }
  if (concern.trigger.type === "tracker_event") {
    // TRACK-6: the role's INBOX is a tracker project. The backing trigger is a normal
    // tracker_event trigger (the SAME github-issues poller picks it up) whose config
    // ALSO carries `roleConcern` — on crystallise the poller stamps the role's name +
    // skills into the spec. The concern's own `repoPath` is the allowlisted local
    // targetRepoPath (the poller re-validates it fail-closed). No `action` — a
    // tracker trigger never fires a loop directly (it produces a spec PR).
    const f = concern.trigger.filter as { tracker: "github"; repo: string; label: string };
    return {
      type: "tracker_event",
      config: {
        tracker: f.tracker,
        repo: f.repo,
        targetRepoPath: concern.repoPath,
        filter: { label: f.label },
        specStatus: "ready",
        roleConcern: binding,
      } as TriggerConfig,
    };
  }
  const f = concern.trigger.filter as { repository: string; events?: string[]; refFilter?: string };
  return {
    type: "github_event",
    config: {
      repository: f.repository,
      events: f.events ?? [],
      ...(f.refFilter ? { refFilter: f.refFilter } : {}),
      roleConcern: binding,
    } as TriggerConfig,
  };
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
      // ROLE-2: concerns start empty (added via the concern endpoints); policy optional.
      concerns: [],
      policy: body.policy ?? null,
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

  // ─── ROLE-2: ADD a concern — materialises a BACKING trigger ────────────────
  // A concern is WHAT the role watches + WHERE + the wake focus. Adding one creates a
  // backing trigger (config carries `roleConcern={roleId,concernId}`) in the EXISTING
  // trigger runtime; when it fires the dispatch wakes the role. No new runtime is added
  // (§6). The concern is appended to the role's `concerns` (the durable declaration).
  app.post("/api/roles/:id/concerns", validateBody(AddConcernSchema), async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const body = req.body as z.infer<typeof AddConcernSchema>;

    const role = await storage.getStandingRole(String(req.params.id));
    if (!role) return res.status(404).json({ error: "Role not found" });

    // Materialise the concern + its backing trigger via the shared helper (same wiring
    // import uses). createTrigger sets projectId from the request ALS (project-scoped).
    const concern = await materializeConcern(storage, role.id, {
      repoPath: body.repoPath,
      focus: body.focus,
      trigger: body.trigger as StandingRoleConcern["trigger"],
      enabled: body.enabled,
    });

    const concerns = [...((role.concerns ?? []) as StandingRoleConcern[]), concern];
    const updated = await storage.updateStandingRole(String(req.params.id), {
      concerns,
    } as Partial<InsertStandingRole>);
    return res.status(201).json(updated);
  });

  // ─── ROLE-2: DELETE a concern — tears down its backing trigger ─────────────
  app.delete("/api/roles/:id/concerns/:concernId", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });

    const role = await storage.getStandingRole(String(req.params.id));
    if (!role) return res.status(404).json({ error: "Role not found" });
    const concerns = (role.concerns ?? []) as StandingRoleConcern[];
    const concern = concerns.find((c) => c.id === String(req.params.concernId));
    if (!concern) return res.status(404).json({ error: "Concern not found" });

    // Best-effort tear down the backing trigger so a removed concern stops firing.
    if (concern.triggerId) {
      try {
        await storage.deleteTrigger(concern.triggerId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[roles] backing trigger delete failed:", err instanceof Error ? err.message : String(err));
      }
    }
    const updated = await storage.updateStandingRole(String(req.params.id), {
      concerns: concerns.filter((c) => c.id !== concern.id),
    } as Partial<InsertStandingRole>);
    return res.json(updated);
  });

  // ─── ROLE-2: the loops this role has WOKEN (trigger wakes + manual wakes) ───
  // Reads the project-scoped loop list and returns those whose provenance names this
  // role — so the UI can show "which triggers are bound and the loops a role has woken".
  app.get("/api/roles/:id/woken-loops", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const role = await storage.getStandingRole(String(req.params.id));
    if (!role) return res.status(404).json({ error: "Role not found" });
    const loops = await storage.getLoops();
    const woken = loops.filter((l) => l.triggerProvenance?.role?.roleId === role.id);
    return res.json(woken);
  });

  // ─── ROLE-4: TRACK RECORD → the "proven → graduate" signal ─────────────────
  // READ-ONLY (standing-role.md §8, ADR-0002 success-delta): compute the role's measured
  // track record from its woken loops' terminal states + its ROLE-SCOPED (fail-closed)
  // Experience items, and derive the graduation-readiness verdict. Mutates NOTHING — a
  // read of this endpoint can never alter a loop or an item. `proven` is EARNED from
  // ground truth here; there is no user-settable "proven" field anywhere.
  app.get("/api/roles/:id/track-record", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const role = await storage.getStandingRole(String(req.params.id));
    if (!role) return res.status(404).json({ error: "Role not found" });

    // Both reads are project-scoped by the request ALS. Experience items are filtered to
    // THIS role fail-closed inside the pure computation (scope.role === role.id); a
    // generous limit so an active role's full record is seen (role-id filter is exact).
    const [loops, items] = await Promise.all([
      storage.getLoops(),
      storage.listExperienceItems(2000),
    ]);
    const readiness = computeRoleGraduation(role.id, loops, items);
    return res.json(readiness);
  });

  // ─── ROLE-4: EXPORT a role as a portable, shareable definition ─────────────
  // Emits the DEFINITION only (persona/skills-by-name/loopTemplate/policy/concerns) with
  // NO runtime/identity/secret state — see `roleToDefinition`. The JSON a human hands to
  // another project (or attaches to a genai-enablement ADR for cross-repo graduation).
  app.get("/api/roles/:id/export", async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const role = await storage.getStandingRole(String(req.params.id));
    if (!role) return res.status(404).json({ error: "Role not found" });

    const { definition, skillsDropped } = await roleToDefinition(storage, role);
    // Suggest a filename; the client can save the body verbatim.
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="role-${role.name.replace(/[^A-Za-z0-9._-]/g, "_")}.json"`,
    );
    if (skillsDropped > 0) res.setHeader("X-Skills-Dropped", String(skillsDropped));
    return res.json(definition);
  });

  // ─── ROLE-4: IMPORT a role FROM a portable definition ──────────────────────
  // Create-from-definition (standing-role.md §8). SAFETY:
  //   - schemaVersion mismatch → 400 (fail-closed, never a silent mis-map).
  //   - skills re-resolved by NAME against THIS project's registry, FAIL-CLOSED (an
  //     unknown skill → 400, NOTHING created) — the import trust gate.
  //   - the role is ALWAYS created DISABLED (§6: enabling a role is a human act) — an
  //     imported definition can never wake work on arrival.
  //   - persona/focus stay UNTRUSTED end-to-end (fenced by the factory at any later wake).
  //   - no cross-repo auto-push / auto-graduation — import is a LOCAL create only.
  app.post("/api/roles/import", validateBody(ImportRoleSchema), async (req: Request, res: Response) => {
    if (!req.user?.id) return res.status(401).json({ error: "Authentication required" });
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const def = req.body as z.infer<typeof ImportRoleSchema>;

    if (def.schemaVersion !== STANDING_ROLE_DEFINITION_VERSION) {
      return res.status(400).json({
        error: `unsupported definition schemaVersion ${def.schemaVersion} (this server imports version ${STANDING_ROLE_DEFINITION_VERSION})`,
      });
    }

    // Fail-closed skill re-validation against the TARGET registry (by name).
    const resolved = await resolveSkillNames(storage, def.skills.map((s) => s.name));
    if ("unknownName" in resolved) {
      return res.status(400).json({
        error: `skill "${resolved.unknownName}" from the imported definition was not found in this project — create it first, then re-import.`,
      });
    }

    // Create the role DISABLED with the LOCAL skill ids. Concerns are materialised
    // AFTER (each needs the role id for its backing-trigger binding).
    const created = await storage.createStandingRole({
      name: def.name,
      persona: def.persona,
      skills: resolved.ids,
      loopTemplate: def.loopTemplate,
      concerns: [],
      policy: def.policy ?? null,
      // §6: import NEVER enables — a shared definition arrives inert; a human enables it.
      enabled: false,
      createdBy: req.user.id,
    } as InsertStandingRole);

    // Re-materialise each concern's backing trigger (shared wiring). The role is disabled,
    // so none can fire until a human enables it (double-gated: role + concern `enabled`).
    if (def.concerns.length > 0) {
      const concerns: StandingRoleConcern[] = [];
      for (const c of def.concerns) {
        concerns.push(
          await materializeConcern(storage, created.id, {
            repoPath: c.repoPath,
            focus: c.focus,
            trigger: c.trigger as StandingRoleConcern["trigger"],
            enabled: c.enabled,
          }),
        );
      }
      const updated = await storage.updateStandingRole(created.id, {
        concerns,
      } as Partial<InsertStandingRole>);
      return res.status(201).json(updated);
    }

    return res.status(201).json(created);
  });
}
