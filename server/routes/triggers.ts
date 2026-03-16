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
import { requireRole } from "../auth/middleware.js";

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

const ScheduleConfigSchema = z.object({
  cron: z.string().min(1).max(200),
  timezone: z.string().max(100).optional(),
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

// ─── Route registration ───────────────────────────────────────────────────────

export function registerTriggerRoutes(app: Express, triggerService: TriggerService): void {

  // GET /api/pipelines/:pipelineId/triggers
  app.get("/api/pipelines/:pipelineId/triggers", async (req, res) => {
    try {
      const pipelineId = String(req.params.pipelineId);
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
  app.post(
    "/api/pipelines/:pipelineId/triggers",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const pipelineId = String(req.params.pipelineId);
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
  app.get("/api/triggers/:id", async (req, res) => {
    try {
      const trigger = await triggerService.getTrigger(String(req.params.id));
      if (!trigger) return res.status(404).json({ error: "Trigger not found" });
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
  app.patch(
    "/api/triggers/:id",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const body = UpdateTriggerSchema.parse(req.body);

        // Fix 3: if type is provided, validate config against the new type
        if (body.type !== undefined && body.config !== undefined) {
          body.config = validateTriggerConfig(body.type, body.config);
        }

        const trigger = await triggerService.updateTrigger(String(req.params.id), {
          type: body.type,
          config: body.config !== undefined ? (body.config as never) : undefined,
          secret: body.secret,
          enabled: body.enabled,
        });

        if (!trigger) return res.status(404).json({ error: "Trigger not found" });
        return res.json(trigger);
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
  app.delete(
    "/api/triggers/:id",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
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
  app.post(
    "/api/triggers/:id/enable",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const trigger = await triggerService.enableTrigger(String(req.params.id));
        if (!trigger) return res.status(404).json({ error: "Trigger not found" });
        return res.json(trigger);
      } catch (e) {
        const cid = correlationId();
        console.error(`[triggers] POST enable trigger error cid=${cid}`, e);
        return res.status(500).json({ error: "Internal server error", correlationId: cid });
      }
    },
  );

  // POST /api/triggers/:id/disable
  app.post(
    "/api/triggers/:id/disable",
    requireRole("maintainer", "admin"),
    async (req, res) => {
      try {
        const trigger = await triggerService.disableTrigger(String(req.params.id));
        if (!trigger) return res.status(404).json({ error: "Trigger not found" });
        return res.json(trigger);
      } catch (e) {
        const cid = correlationId();
        console.error(`[triggers] POST disable trigger error cid=${cid}`, e);
        return res.status(500).json({ error: "Internal server error", correlationId: cid });
      }
    },
  );
}
