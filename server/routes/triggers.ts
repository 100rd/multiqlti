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

// ─── Correlation ID helper ────────────────────────────────────────────────────

/** Generate a short correlation ID for error tracking. */
function correlationId(): string {
  return randomUUID().slice(0, 8);
}

// ─── Fix 3: Strict per-type config schemas (no passthrough catch-all) ─────────

const WebhookConfigSchema = z.object({
  // Webhook config is intentionally empty — secret is passed as top-level `secret` field
  // and the endpoint is auto-derived. Accept no unknown keys.
}).strict();

// VETO-2 fix: add IANA timezone validation via Intl.DateTimeFormat constructor.
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
});

const GitHubConfigSchema = z.object({
  repository: z.string().min(1).max(500).regex(/^[^/]+\/[^/]+$/, "Must be in owner/repo format"),
  events: z.array(z.string().min(1).max(100)).min(1).max(50),
  refFilter: z.string().max(500).optional(),
});

const FileChangeConfigSchema = z.object({
  watchPath: z.string().min(1).max(4096),
  patterns: z.array(z.string().min(1).max(500)).optional(),
  debounceMs: z.number().int().min(0).max(30_000).optional(),
  input: z.string().max(100_000).optional(),
});

type TriggerTypeValue = "webhook" | "schedule" | "github_event" | "file_change";

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
  }
}

// ─── Top-level request schemas ────────────────────────────────────────────────

const TriggerTypeEnum = z.enum(["webhook", "schedule", "github_event", "file_change"]);

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

      const pipelines = await storage.getPipelines();
      const allTriggers = await Promise.all(
        pipelines.map((p) => triggerService.getTriggers(p.id))
      );
      return res.json(allTriggers.flat());
    } catch (e) {
      const cid = correlationId();
      console.error(`[triggers] GET /api/triggers error cid=${cid}`, e);
      return res.status(500).json({ error: "Internal server error", correlationId: cid });
    }
  });

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

      const allowed = await assertPipelineOwnership(trigger.pipelineId, storage, req, res);
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

  // PATCH /api/triggers/:id
  // VETO-1: resolve trigger → pipeline → ownership check before mutating.
  app.patch(
    "/api/triggers/:id",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const trigger = await triggerService.getTrigger(String(req.params.id));
        if (!trigger) return res.status(404).json({ error: "Trigger not found" });

        const allowed = await assertPipelineOwnership(trigger.pipelineId, storage, req, res);
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

        const allowed = await assertPipelineOwnership(trigger.pipelineId, storage, req, res);
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

        const allowed = await assertPipelineOwnership(trigger.pipelineId, storage, req, res);
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

        const allowed = await assertPipelineOwnership(trigger.pipelineId, storage, req, res);
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
