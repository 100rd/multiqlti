/**
 * Webhook receipt routes — public endpoints that receive webhook POSTs.
 *
 * POST /api/webhooks/:triggerId        — receive a generic webhook
 * POST /api/github-events              — receive a GitHub event (routes to all matching triggers)
 */
import type { Express } from "express";
import { randomUUID } from "crypto";
import { ZodError } from "zod";
import type { TriggerRow } from "@shared/schema";
import type { IStorage } from "../storage.js";
import type { TriggerService } from "../services/trigger-service.js";
import {
  handleWebhookRequest,
  startRateLimitCleanup,
} from "../services/webhook-handler.js";
import { handleGitHubEvent } from "../services/github-event-handler.js";

function correlationId(): string {
  return randomUUID().slice(0, 8);
}

export function registerWebhookRoutes(
  app: Express,
  storage: IStorage,
  triggerService: TriggerService,
  fireTrigger: (trigger: TriggerRow, payload: unknown) => Promise<void>,
): void {
  // Start the rate-limit map cleanup interval
  startRateLimitCleanup();

  // POST /api/webhooks/:triggerId — generic webhook receiver
  app.post("/api/webhooks/:triggerId", async (req, res) => {
    try {
      await handleWebhookRequest(req, res, {
        getTrigger: (id) => storage.getTrigger(id),
        getSecret: (id) => triggerService.getSecret(id),
        fireTrigger,
      });
    } catch (e) {
      if (e instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", issues: e.issues });
      }
      const cid = correlationId();
      console.error(`[webhooks] POST webhook error cid=${cid}`, e);
      return res.status(500).json({ error: "Internal server error", correlationId: cid });
    }
  });

  // POST /api/github-events — GitHub webhook event router
  app.post("/api/github-events", async (req, res) => {
    try {
      const result = await handleGitHubEvent(
        req.rawBody,
        req.headers as Record<string, string | string[] | undefined>,
        req.body as unknown,
        {
          getEnabledTriggersByType: (type) => storage.getEnabledTriggersByType(type),
          getSecret: (id) => triggerService.getSecret(id),
          fireTrigger,
        },
      );

      // VETO-3 fix: do NOT return internal trigger IDs or raw error strings to the
      // unauthenticated caller. Log the full result server-side for audit purposes
      // and return only aggregate counts so callers can confirm delivery.
      const cid = correlationId();
      if (result.errors && result.errors.length > 0) {
        console.error({ cid, fired: result.fired?.length, errors: result.errors }, "github-events partial failure");
      }
      return res.json({ fired: result.fired?.length ?? 0 });
    } catch (e) {
      if (e instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", issues: e.issues });
      }
      const cid = correlationId();
      console.error(`[webhooks] POST github-events error cid=${cid}`, e);
      return res.status(500).json({ error: "Internal server error", correlationId: cid });
    }
  });
}
