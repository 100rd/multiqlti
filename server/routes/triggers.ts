/**
 * Trigger CRUD API routes — Phase 6.3
 *
 * GET    /api/pipelines/:pipelineId/triggers        — list triggers for a pipeline
 * POST   /api/pipelines/:pipelineId/triggers        — create a trigger
 * GET    /api/triggers/:id                          — get single trigger
 * PATCH  /api/triggers/:id                          — update trigger
 * DELETE /api/triggers/:id                          — delete trigger
 * POST   /api/triggers/:id/enable                   — enable trigger
 * POST   /api/triggers/:id/disable                  — disable trigger
 */
import type { Express } from "express";
import { z, ZodError } from "zod";
import { randomUUID } from "crypto";
import type { TriggerService } from "../services/trigger-service.js";
import type { IStorage } from "../storage.js";
import { requireRole, requireOwnerOrRole } from "../auth/middleware.js";
import { CONSILIUM_REVIEW_PRESETS, TRIGGER_FIRED_LOOPS_LIMIT } from "@shared/types";
import type { TriggerFiredLoop, TriggerFiredLoopsResponse } from "@shared/types";
import type { ConsiliumLoopRow } from "@shared/schema";

// ─── Correlation ID helper ────────────────────────────────────────────────────

/** Generate a short correlation ID for error tracking. */
function correlationId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Sort key for a fired loop: the provenance `firedAt` instant in ms, falling back
 * to the row's `createdAt` when a legacy row has no firedAt. Used to order fired
 * loops newest-first for GET /api/triggers/:id/loops.
 */
function firedAtMs(loop: ConsiliumLoopRow): number {
  const firedAt = loop.triggerProvenance?.firedAt;
  const t = firedAt ? Date.parse(firedAt) : NaN;
  return Number.isNaN(t) ? new Date(loop.createdAt).getTime() : t;
}

// ─── Fix 3: Strict per-type config schemas (no passthrough catch-all) ─────────

const WebhookConfigSchema = z.object({
  // Webhook config is intentionally empty — secret is passed as top-level `secret` field
  // and the endpoint is auto-derived. Accept no unknown keys.
}).strict();

// T1 loop template (loop-triggers.md §2): the SHARED "target = a consilium loop"
// shape carried in the trigger config JSONB. `repoPath` is re-validated against the
// fail-closed allowlist INSIDE the factory (this schema only shape-checks it).
// `engineerInstruction` is UNTRUSTED free-text (may embed `${event}`) — the factory
// control-strips + byte-clamps + fences it (same seam as the human UI endpoint).
const LoopTemplateActionSchema = z.object({
  kind: z.literal("consilium_review"),
  preset: z.enum(CONSILIUM_REVIEW_PRESETS),
  maxRounds: z.number().int().min(1).max(6).optional(),
  repoPath: z.string().min(1).max(4096).optional(),
  engineerInstruction: z.string().max(8000).optional(),
});

// A SCHEDULE trigger has no watchPath, so its loop template MUST name an explicit
// repoPath (still allowlist-re-validated in the factory).
const ScheduleActionSchema = LoopTemplateActionSchema.extend({
  repoPath: z.string().min(1).max(4096),
});

// VETO-2 fix: add IANA timezone validation via Intl.DateTimeFormat constructor.
// T1 RETARGET: a schedule trigger now REQUIRES a loop template (`action`) — its
// firing creates a consilium loop, not a (deleted) pipeline run.
const ScheduleConfigSchema = z.object({
  cron: z.string().min(1).max(200),
  timezone: z.string().max(100).optional().refine(
    (tz) => {
      if (tz === undefined) return true;
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA timezone identifier" }
  ),
  input: z.string().max(100_000).optional(),
  action: ScheduleActionSchema,
});

// A github_event trigger MAY carry an embedded loop template (`action`) — the
// event→review mapping fires it (PR head diff / post-merge review). Without this
// field the strict z.object would SILENTLY STRIP `action`, turning the trigger into
// a permanent record-only no-op. The factory RE-VALIDATES `repoPath` against the
// fail-closed allowlist, so this schema only shape-checks it. Optional here (a
// github trigger may be configured record-only), but a repoPath is required at
// FIRE time for a review to launch.
const GitHubConfigSchema = z.object({
  repository: z.string().min(1).max(500).regex(/^[^/]+\/[^/]+$/, "Must be in owner/repo format"),
  events: z.array(z.string().min(1).max(100)).min(1).max(50),
  refFilter: z.string().max(500).optional(),
  action: LoopTemplateActionSchema.optional(),
});

// A file_change trigger MAY carry an embedded loop template (`action`). The factory
// RE-VALIDATES `repoPath` against the fail-closed allowlist, so this schema only
// shape-checks it — it is NOT the security boundary. Without this field the strict
// z.object would SILENTLY STRIP `action`, turning the trigger into a permanent
// no-op; declaring it here makes the action persist. Optional here (a file_change
// trigger may derive repoPath from watchPath); required for schedule (above).
const FileChangeConfigSchema = z.object({
  watchPath: z.string().min(1).max(4096),
  patterns: z.array(z.string().min(1).max(500)).optional(),
  debounceMs: z.number().int().min(0).max(30_000).optional(),
  input: z.string().max(100_000).optional(),
  action: LoopTemplateActionSchema.optional(),
});

// TRACK-1 (github) — byte-identical shape, now the `github` arm of the union.
const GithubTrackerConfigSchema = z.object({
  tracker: z.literal("github"),
  repo: z.string().min(1).max(500).regex(/^[^/]+\/[^/]+$/, "Must be owner/repo"),
  targetRepoPath: z.string().min(1).max(4096),
  filter: z.object({ label: z.string().min(1).max(200).optional() }).optional(),
  specStatus: z.enum(["ready", "draft"]).optional(),
});

// TRACK-3 (jira) — JQL poll → committed spec PR in `repo` (the git repo) + Jira pickup.
const JiraTrackerConfigSchema = z.object({
  tracker: z.literal("jira"),
  baseUrl: z.string().min(1).max(500).url().startsWith("https://", "Jira baseUrl must be https"),
  project: z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/, "Jira project key: alnum/underscore"),
  jql: z.string().max(2000).optional(),
  transitionTo: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(500).regex(/^[^/]+\/[^/]+$/, "Must be owner/repo (the git repo the spec PR lands in)"),
  targetRepoPath: z.string().min(1).max(4096),
  filter: z.object({ label: z.string().min(1).max(200).optional() }).optional(),
  specStatus: z.enum(["ready", "draft"]).optional(),
});

// TRACK-5 (linear) — GraphQL poll → committed spec PR in `repo` (the git repo) + pickup.
const LinearTrackerConfigSchema = z.object({
  tracker: z.literal("linear"),
  baseUrl: z.string().min(1).max(500).url().startsWith("https://", "Linear baseUrl must be https").optional(),
  linearTeamId: z.string().min(1).max(200).optional(),
  transitionTo: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(500).regex(/^[^/]+\/[^/]+$/, "Must be owner/repo (the git repo the spec PR lands in)"),
  targetRepoPath: z.string().min(1).max(4096),
  filter: z.object({ label: z.string().min(1).max(200).optional() }).optional(),
  specStatus: z.enum(["ready", "draft"]).optional(),
});

// TRACK-5 (azure) — WIQL poll → committed spec PR in `repo` (the git repo) + pickup.
const AzureTrackerConfigSchema = z.object({
  tracker: z.literal("azure"),
  baseUrl: z.string().min(1).max(500).url().startsWith("https://", "Azure baseUrl must be https").optional(),
  azureOrg: z.string().min(1).max(100),
  project: z.string().min(1).max(100),
  azureAreaPath: z.string().min(1).max(400).optional(),
  transitionTo: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(500).regex(/^[^/]+\/[^/]+$/, "Must be owner/repo (the git repo the spec PR lands in)"),
  targetRepoPath: z.string().min(1).max(4096),
  filter: z.object({ label: z.string().min(1).max(200).optional() }).optional(),
  specStatus: z.enum(["ready", "draft"]).optional(),
});

// TRACK-5 (clickup) — REST poll → committed spec PR in `repo` (the git repo) + pickup.
const ClickUpTrackerConfigSchema = z.object({
  tracker: z.literal("clickup"),
  baseUrl: z.string().min(1).max(500).url().startsWith("https://", "ClickUp baseUrl must be https").optional(),
  clickupListId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, "ClickUp list id: alnum/._-"),
  transitionTo: z.string().min(1).max(200).optional(),
  repo: z.string().min(1).max(500).regex(/^[^/]+\/[^/]+$/, "Must be owner/repo (the git repo the spec PR lands in)"),
  targetRepoPath: z.string().min(1).max(4096),
  filter: z.object({ label: z.string().min(1).max(200).optional() }).optional(),
  specStatus: z.enum(["ready", "draft"]).optional(),
});

// Discriminated on `tracker` so a bad/absent kind yields a precise 400 (additive: the
// github + jira arms are unchanged, so existing trigger creation validates identically;
// TRACK-5 adds the linear/azure/clickup arms).
const TrackerConfigSchema = z.discriminatedUnion("tracker", [
  GithubTrackerConfigSchema,
  JiraTrackerConfigSchema,
  LinearTrackerConfigSchema,
  AzureTrackerConfigSchema,
  ClickUpTrackerConfigSchema,
]);

type TriggerTypeValue = "webhook" | "schedule" | "github_event" | "file_change" | "tracker_event";

/**
 * Fix 3: Discriminated union validator — picks the correct schema based on type.
 * Throws ZodError if validation fails so callers can return 400.
 */
function validateTriggerConfig(type: TriggerTypeValue, config: unknown): unknown {
  switch (type) {
    case "webhook":
      return WebhookConfigSchema.parse(config ?? {});
    case "schedule":
      return ScheduleConfigSchema.parse(config);
    case "github_event":
      return GitHubConfigSchema.parse(config);
    case "file_change":
      return FileChangeConfigSchema.parse(config);
    case "tracker_event":
      return TrackerConfigSchema.parse(config);
  }
}

// ─── Top-level request schemas ────────────────────────────────────────────────

const TriggerTypeEnum = z.enum(["webhook", "schedule", "github_event", "file_change", "tracker_event"]);

const CreateTriggerSchema = z.object({
  type: TriggerTypeEnum,
  config: z.unknown(),
  secret: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
});

const UpdateTriggerSchema = z.object({
  type: TriggerTypeEnum.optional(),
  config: z.unknown().optional(),
  secret: z.string().max(1000).nullable().optional(),
  enabled: z.boolean().optional(),
});

// ─── Ownership gate helper ────────────────────────────────────────────────────

import type { Request, Response } from "express";

/**
 * VETO-1 fix: Resolves the pipeline for a given pipelineId, enforces ownership
 * via requireOwnerOrRole, and returns true if the check passed (i.e. next() was
 * called and we should continue). Returns false if a response was already sent
 * (401/403/404) and the handler should return immediately.
 */
async function assertPipelineOwnership(
  pipelineId: string,
  storage: IStorage,
  req: Request,
  res: Response,
): Promise<boolean> {
  const pipeline = await storage.getPipeline(pipelineId);
  if (!pipeline) {
    res.status(404).json({ error: "Pipeline not found" });
    return false;
  }

  const ownerId = pipeline.ownerId;
  let passed = false;
  await new Promise<void>((resolve) => {
    const middleware = requireOwnerOrRole(() => ownerId, "admin");
    middleware(req, res, () => {
      passed = true;
      resolve();
    });
    // If the middleware sent a 401/403, the response finishes — resolve to avoid hanging.
    res.on("finish", () => resolve());
  });

  return passed && !res.headersSent;
}

/**
 * T1: authorize a per-id trigger operation. A LEGACY pipeline trigger is gated on
 * its pipeline's owner (unchanged). A pipeline-less loop-template trigger has no
 * pipeline owner to check — but it was already fetched via a PROJECT-SCOPED
 * `getTrigger` (so it belongs to req.projectId, which requireProject validated the
 * caller is a member of), and the mutating routes additionally carry
 * requireRole("maintainer","admin"). So project scope + role are the boundary here.
 */
async function assertTriggerAccess(
  trigger: { pipelineId: string | null },
  storage: IStorage,
  req: Request,
  res: Response,
): Promise<boolean> {
  if (trigger.pipelineId) {
    return assertPipelineOwnership(trigger.pipelineId, storage, req, res);
  }
  return true;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerTriggerRoutes(app: Express, triggerService: TriggerService, storage: IStorage): void {

  // GET /api/triggers — list all triggers across all pipelines the current user can see
  app.get("/api/triggers", async (req, res) => {
    try {
      const pipelineId = req.query.pipelineId ? String(req.query.pipelineId) : undefined;
      if (pipelineId) {
        const allowed = await assertPipelineOwnership(pipelineId, storage, req, res);
        if (!allowed) return;
        return res.json(await triggerService.getTriggers(pipelineId));
      }

      // T1: return the PROJECT's triggers (project-scoped), including pipeline-less
      // loop-template triggers. requireProject upstream validated membership and set
      // the ALS project the query filters by. (The old pipeline-fan-out returned []
      // once the pipeline entity left the product.)
      return res.json(await triggerService.getProjectTriggers());
    } catch (e) {
      const cid = correlationId();
      console.error(`[triggers] GET /api/triggers error cid=${cid}`, e);
      return res.status(500).json({ error: "Internal server error", correlationId: cid });
    }
  });

  // POST /api/triggers — PROJECT-SCOPED create (T1 retarget).
  //
  // The trigger entity was pipeline-shaped: created under /api/pipelines/:id/triggers
  // and requiring a pipeline. The pipeline entity left the product, so there were
  // ZERO pipelines and no trigger could be created (the "Add Trigger" button was
  // permanently disabled). A trigger now targets a CONSILIUM LOOP (loop template in
  // `config`) and is scoped to the request's PROJECT (x-project-id → req.projectId,
  // set by requireProject upstream). `createTrigger` runs inside the request's
  // project ALS, so `withProjectInsert` stamps projectId; pipelineId is null.
  //
  // The factory (invoked when the trigger later FIRES) re-validates repoPath against
  // the fail-closed allowlist AND the project's own workspaces — this route only
  // shape-validates. No secret path here (loop-template triggers use no HMAC secret;
  // webhook/github secrets still flow through the legacy pipeline route).
  app.post(
    "/api/triggers",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        if (!req.projectId) {
          return res.status(400).json({ error: "x-project-id header is required" });
        }

        const body = CreateTriggerSchema.parse(req.body);
        const validatedConfig = validateTriggerConfig(body.type, body.config);

        const trigger = await triggerService.createTrigger({
          // T1: no pipeline — projectId is stamped from the request ALS by storage.
          type: body.type,
          config: validatedConfig as never,
          secret: body.secret,
          enabled: body.enabled,
        });

        return res.status(201).json(trigger);
      } catch (e) {
        if (e instanceof ZodError) {
          return res.status(400).json({ error: "Validation failed", issues: e.issues });
        }
        const cid = correlationId();
        console.error(`[triggers] POST /api/triggers error cid=${cid}`, e);
        return res.status(500).json({ error: "Internal server error", correlationId: cid });
      }
    },
  );

  // GET /api/pipelines/:pipelineId/triggers
  // VETO-1: resolve pipeline and gate on ownership before returning triggers.
  app.get("/api/pipelines/:pipelineId/triggers", async (req, res) => {
    try {
      const pipelineId = String(req.params.pipelineId);

      const allowed = await assertPipelineOwnership(pipelineId, storage, req, res);
      if (!allowed) return;

      const triggers = await triggerService.getTriggers(pipelineId);
      return res.json(triggers);
    } catch (e) {
      if (e instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", issues: e.issues });
      }
      const cid = correlationId();
      console.error(`[triggers] GET pipeline triggers error cid=${cid}`, e);
      return res.status(500).json({ error: "Internal server error", correlationId: cid });
    }
  });

  // POST /api/pipelines/:pipelineId/triggers
  // VETO-1: gate on pipeline ownership before creating triggers.
  // NOTE: New schedule/file_change triggers are stored in DB but only activated
  // on server restart. Live activation is tracked in issue #XXX.
  app.post(
    "/api/pipelines/:pipelineId/triggers",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const pipelineId = String(req.params.pipelineId);

        const allowed = await assertPipelineOwnership(pipelineId, storage, req, res);
        if (!allowed) return;

        const body = CreateTriggerSchema.parse(req.body);

        // Fix 3: validate config against the specific type schema
        const validatedConfig = validateTriggerConfig(body.type, body.config);

        const trigger = await triggerService.createTrigger({
          pipelineId,
          type: body.type,
          config: validatedConfig as never,
          secret: body.secret,
          enabled: body.enabled,
        });

        return res.status(201).json(trigger);
      } catch (e) {
        if (e instanceof ZodError) {
          return res.status(400).json({ error: "Validation failed", issues: e.issues });
        }
        const cid = correlationId();
        console.error(`[triggers] POST create trigger error cid=${cid}`, e);
        return res.status(500).json({ error: "Internal server error", correlationId: cid });
      }
    },
  );

  // GET /api/triggers/:id
  // VETO-1: resolve trigger → pipelineId → pipeline owner → ownership check.
  app.get("/api/triggers/:id", async (req, res) => {
    try {
      const trigger = await triggerService.getTrigger(String(req.params.id));
      if (!trigger) return res.status(404).json({ error: "Trigger not found" });

      const allowed = await assertTriggerAccess(trigger, storage, req, res);
      if (!allowed) return;

      return res.json(trigger);
    } catch (e) {
      if (e instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", issues: e.issues });
      }
      const cid = correlationId();
      console.error(`[triggers] GET trigger error cid=${cid}`, e);
      return res.status(500).json({ error: "Internal server error", correlationId: cid });
    }
  });

  // GET /api/triggers/:id/loops
  //
  // The "how do I find the result of a fire" endpoint. A trigger fire creates a
  // consilium loop that records `triggerProvenance` (triggerId, firedAt,
  // eventDigest, eventSummary) on the loop row (#457/#471). This route returns the
  // loops THIS trigger created, newest first, so the operator can click through to
  // each ConsiliumLoopDetail and read the PR / verdict.
  //
  // AUTH: inherits `requireAuth + requireProject` from the `/api/triggers` mount
  // (routes.ts) — no per-route auth to forget (the /api/pr-queue 401 lesson). The
  // trigger is additionally fetched via the PROJECT-SCOPED `getTrigger` and gated
  // by assertTriggerAccess, exactly like GET /api/triggers/:id.
  //
  // SCOPE: loops are read via `storage.getLoops()`, which is PROJECT-scoped by the
  // requireProject ALS context (a loop belongs to a project-scoped task group) —
  // NOT owner-scoped, because a trigger-fired loop's `createdBy` is the project
  // OWNER, so owner-scoping would hide fires from other project members. We then
  // keep only loops whose `triggerProvenance.triggerId === :id` (human/API loops
  // have null provenance and are correctly excluded). `firedCount` is the full
  // total; the returned `loops` list is BOUNDED (a trigger with hundreds of fires
  // must not return them all).
  app.get("/api/triggers/:id/loops", async (req, res) => {
    try {
      const trigger = await triggerService.getTrigger(String(req.params.id));
      if (!trigger) return res.status(404).json({ error: "Trigger not found" });

      const allowed = await assertTriggerAccess(trigger, storage, req, res);
      if (!allowed) return;

      const all = await storage.getLoops();
      const fired = all
        .filter((l) => l.triggerProvenance?.triggerId === trigger.id)
        // Newest fire first. `firedAt` is the provenance instant; fall back to
        // the row's createdAt if a legacy row lacks it.
        .sort((a, b) => firedAtMs(b) - firedAtMs(a));

      const loops: TriggerFiredLoop[] = fired
        .slice(0, TRIGGER_FIRED_LOOPS_LIMIT)
        .map((l) => {
          const prov = l.triggerProvenance!;
          return {
            loopId: l.id,
            state: l.state,
            prRef: l.prRef ?? null,
            eventSummary: prov.eventSummary ?? null,
            // `eventDigest` is now optional on TriggerProvenance (a ROLE-1 wake has
            // none) — but these loops are already filtered to trigger fires
            // (`triggerId === trigger.id`), which always carry a digest; `?? ""` is
            // a defensive fallback that keeps the field a string.
            eventDigest: prov.eventDigest ?? "",
            firedAt: prov.firedAt ?? new Date(l.createdAt).toISOString(),
          };
        });

      const body: TriggerFiredLoopsResponse = {
        triggerId: trigger.id,
        firedCount: fired.length,
        loops,
      };
      return res.json(body);
    } catch (e) {
      const cid = correlationId();
      console.error(`[triggers] GET trigger loops error cid=${cid}`, e);
      return res.status(500).json({ error: "Internal server error", correlationId: cid });
    }
  });

  // PATCH /api/triggers/:id
  // VETO-1: resolve trigger → pipeline → ownership check before mutating.
  app.patch(
    "/api/triggers/:id",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const trigger = await triggerService.getTrigger(String(req.params.id));
        if (!trigger) return res.status(404).json({ error: "Trigger not found" });

        const allowed = await assertTriggerAccess(trigger, storage, req, res);
        if (!allowed) return;

        const body = UpdateTriggerSchema.parse(req.body);

        // Fix 3: if type is provided, validate config against the new type
        if (body.type !== undefined && body.config !== undefined) {
          body.config = validateTriggerConfig(body.type, body.config);
        }

        const updated = await triggerService.updateTrigger(String(req.params.id), {
          type: body.type,
          config: body.config !== undefined ? (body.config as never) : undefined,
          secret: body.secret,
          enabled: body.enabled,
        });

        if (!updated) return res.status(404).json({ error: "Trigger not found" });
        return res.json(updated);
      } catch (e) {
        if (e instanceof ZodError) {
          return res.status(400).json({ error: "Validation failed", issues: e.issues });
        }
        const cid = correlationId();
        console.error(`[triggers] PATCH update trigger error cid=${cid}`, e);
        return res.status(500).json({ error: "Internal server error", correlationId: cid });
      }
    },
  );

  // DELETE /api/triggers/:id
  // VETO-1: resolve trigger → pipeline → ownership check before deleting.
  app.delete(
    "/api/triggers/:id",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const trigger = await triggerService.getTrigger(String(req.params.id));
        if (!trigger) return res.status(404).json({ error: "Trigger not found" });

        const allowed = await assertTriggerAccess(trigger, storage, req, res);
        if (!allowed) return;

        const deleted = await triggerService.deleteTrigger(String(req.params.id));
        if (!deleted) return res.status(404).json({ error: "Trigger not found" });
        return res.status(204).send();
      } catch (e) {
        if (e instanceof ZodError) {
          return res.status(400).json({ error: "Validation failed", issues: e.issues });
        }
        const cid = correlationId();
        console.error(`[triggers] DELETE trigger error cid=${cid}`, e);
        return res.status(500).json({ error: "Internal server error", correlationId: cid });
      }
    },
  );

  // POST /api/triggers/:id/enable
  // VETO-1: resolve trigger → pipeline → ownership check before enabling.
  app.post(
    "/api/triggers/:id/enable",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const trigger = await triggerService.getTrigger(String(req.params.id));
        if (!trigger) return res.status(404).json({ error: "Trigger not found" });

        const allowed = await assertTriggerAccess(trigger, storage, req, res);
        if (!allowed) return;

        const updated = await triggerService.enableTrigger(String(req.params.id));
        if (!updated) return res.status(404).json({ error: "Trigger not found" });
        return res.json(updated);
      } catch (e) {
        const cid = correlationId();
        console.error(`[triggers] POST enable trigger error cid=${cid}`, e);
        return res.status(500).json({ error: "Internal server error", correlationId: cid });
      }
    },
  );

  // POST /api/triggers/:id/disable
  // VETO-1: resolve trigger → pipeline → ownership check before disabling.
  app.post(
    "/api/triggers/:id/disable",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const trigger = await triggerService.getTrigger(String(req.params.id));
        if (!trigger) return res.status(404).json({ error: "Trigger not found" });

        const allowed = await assertTriggerAccess(trigger, storage, req, res);
        if (!allowed) return;

        const updated = await triggerService.disableTrigger(String(req.params.id));
        if (!updated) return res.status(404).json({ error: "Trigger not found" });
        return res.json(updated);
      } catch (e) {
        const cid = correlationId();
        console.error(`[triggers] POST disable trigger error cid=${cid}`, e);
        return res.status(500).json({ error: "Internal server error", correlationId: cid });
      }
    },
  );
}
