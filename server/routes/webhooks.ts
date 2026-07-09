/**
 * Webhook receipt routes — public endpoints that receive webhook POSTs.
 *
 * POST /api/webhooks/:triggerId        — receive a generic webhook
 * POST /api/github-events              — receive a GitHub event (routes to all matching triggers)
 * POST /api/gitlab-events              — receive a GitLab event (routes to all matching triggers)
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
import { handleGitLabEvent } from "../services/gitlab-event-handler.js";
import { runAsSystem } from "../context.js";

function correlationId(): string {
  return randomUUID().slice(0, 8);
}

export function registerWebhookRoutes(
  app: Express,
  storage: IStorage,
  triggerService: TriggerService,
  // Returns the shared TriggerFireResult (widened to `unknown` — ignored here).
  fireTrigger: (trigger: TriggerRow, payload: unknown) => Promise<unknown>,
): void {
  // Start the rate-limit map cleanup interval
  startRateLimitCleanup();

  // POST /api/webhooks/:triggerId — generic webhook receiver
  app.post("/api/webhooks/:triggerId", async (req, res) => {
    try {
      // CONTEXT FIX: a public webhook POST has NO x-project-id header and runs
      // outside any request-scoped ALS context, but `storage.getTrigger` /
      // `triggerService.getSecret` are project-scoped (they call `withProject`,
      // which THROWS "no request context" otherwise → a 500 on every delivery).
      // A webhook identifies its trigger by id across ALL projects, so it is a
      // cross-project SYSTEM caller: establish a system context for the whole
      // handler (getTrigger + getSecret). `fireTrigger` re-establishes its own
      // system/project context internally, so the nesting is safe.
      await runAsSystem("github-webhook", () =>
        handleWebhookRequest(req, res, {
          getTrigger: (id) => storage.getTrigger(id),
          getSecret: (id) => triggerService.getSecret(id),
          fireTrigger,
        }),
      );
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
      // CONTEXT FIX: like the generic receiver, this public endpoint has no ALS
      // context. `getAllEnabledTriggersByType` (cross-project) AND `getSecret`
      // (→ storage.getTrigger → withProject) BOTH require a system context — the
      // latter was previously unwrapped and 500'd for any trigger WITH a secret
      // (i.e. every HMAC-verified github webhook). Wrap the whole handler in ONE
      // system context so both reads succeed; fireTrigger nests its own context.
      const result = await runAsSystem("github-webhook-event", () =>
        handleGitHubEvent(
          req.rawBody,
          req.headers as Record<string, string | string[] | undefined>,
          req.body as unknown,
          {
            getEnabledTriggersByType: (type) => storage.getAllEnabledTriggersByType(type),
            getSecret: (id) => triggerService.getSecret(id),
            fireTrigger,
          },
        ),
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

  // POST /api/gitlab-events — GitLab webhook event router (mirror of /api/github-events)
  app.post("/api/gitlab-events", async (req, res) => {
    try {
      // CONTEXT FIX (mirrors github-events): this public endpoint has no ALS context.
      // `getAllEnabledTriggersByType` (cross-project) AND `getSecret` (→
      // storage.getTrigger → withProject) BOTH require a system context. Wrap the
      // whole handler in ONE system context so both reads succeed; fireTrigger nests
      // its own context.
      const result = await runAsSystem("gitlab-webhook-event", () =>
        handleGitLabEvent(
          req.rawBody,
          req.headers as Record<string, string | string[] | undefined>,
          req.body as unknown,
          {
            getEnabledTriggersByType: (type) => storage.getAllEnabledTriggersByType(type),
            getSecret: (id) => triggerService.getSecret(id),
            fireTrigger,
          },
        ),
      );

      // VETO-3 fix (mirrors github-events): do NOT return internal trigger IDs or raw
      // error strings to the unauthenticated caller. Log the full result server-side
      // for audit purposes and return only aggregate counts so callers can confirm
      // delivery.
      const cid = correlationId();
      if (result.errors && result.errors.length > 0) {
        console.error({ cid, fired: result.fired?.length, errors: result.errors }, "gitlab-events partial failure");
      }
      return res.json({ fired: result.fired?.length ?? 0 });
    } catch (e) {
      if (e instanceof ZodError) {
        return res.status(400).json({ error: "Validation failed", issues: e.issues });
      }
      const cid = correlationId();
      console.error(`[webhooks] POST gitlab-events error cid=${cid}`, e);
      return res.status(500).json({ error: "Internal server error", correlationId: cid });
    }
  });
}
