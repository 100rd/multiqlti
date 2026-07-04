/**
 * webhook-context.test.ts — REGRESSION GUARD for the public webhook receiver's
 * project-context crash.
 *
 * The bug: `POST /api/webhooks/:triggerId` and `POST /api/github-events` are
 * PUBLIC (no x-project-id) and run outside any request-scoped ALS context, but
 * `storage.getTrigger` / `triggerService.getSecret` are project-scoped — they call
 * `withProject`, which THROWS "no request context" without an ALS context → a 500
 * on EVERY delivery. The real PgStorage path was never functional end-to-end; the
 * #471 tests mocked getTrigger/getSecret with plain objects, so the `withProject`
 * gate was never exercised and the crash was invisible.
 *
 * These tests route the receiver's storage through the REAL `withProject`
 * (server/db.ts) so the missing-context crash cannot regress: the route must
 * establish a system context (runAsSystem) for the whole handler.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { registerWebhookRoutes } from "../../../server/routes/webhooks.js";
import { handleWebhookRequest } from "../../../server/services/webhook-handler.js";
import { withProject } from "../../../server/db.js";
import { triggers, type TriggerRow } from "../../../shared/schema.js";
import type { IStorage } from "../../../server/storage.js";
import type { TriggerService } from "../../../server/services/trigger-service.js";
import type { Request, Response } from "express";

/** An enabled github_event trigger row (no pipeline; project-scoped). */
function ghTrigger(id: string, secretEncrypted: string | null = null): TriggerRow {
  return {
    id,
    projectId: "proj-1",
    pipelineId: null,
    type: "github_event",
    config: {
      repository: "acme/widget",
      events: ["pull_request"],
      action: { kind: "consilium_review", preset: "diff-pr-review", repoPath: "/repo" },
    },
    secretEncrypted,
    enabled: true,
    lastTriggeredAt: null,
    suppressedCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as TriggerRow;
}

/**
 * Build an express app with ONLY the webhook routes, backed by a storage +
 * triggerService whose reads go through the REAL `withProject` gate (so a missing
 * ALS context throws exactly as PgStorage would).
 */
function buildApp(opts: {
  trigger: TriggerRow;
  secret?: string | null;
  fireTrigger: (t: TriggerRow, p: unknown) => Promise<unknown>;
}) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  const storage = {
    // Real project-scope gate — throws "no request context" outside runAsSystem/Project.
    getTrigger: async (id: string) => {
      withProject(triggers, eq(triggers.id, id));
      return opts.trigger.id === id ? opts.trigger : undefined;
    },
    getAllEnabledTriggersByType: async (_type: string) => [opts.trigger],
  } as unknown as IStorage;

  const triggerService = {
    getSecret: async (id: string) => {
      withProject(triggers, eq(triggers.id, id));
      return opts.secret ?? null;
    },
  } as unknown as TriggerService;

  registerWebhookRoutes(app, storage, triggerService, opts.fireTrigger);
  return app;
}

describe("POST /api/webhooks/:triggerId — real project-context path", () => {
  it("returns 200 (not 500) and fires — the route establishes a system context", async () => {
    const fire = vi.fn(async () => "launched");
    const app = buildApp({ trigger: ghTrigger("trig-generic-1"), fireTrigger: fire });

    const res = await request(app)
      .post("/api/webhooks/trig-generic-1")
      .set("X-GitHub-Event", "pull_request")
      .send({ action: "opened", number: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("PROVES the gate bites: handleWebhookRequest WITHOUT a context wrapper throws 'no request context'", async () => {
    // This is the exact shape the #471 route had (unwrapped) — it 500'd in prod.
    const req = {
      params: { triggerId: "trig-x" },
      headers: {},
      body: {},
    } as unknown as Request;
    const res = { status: () => res, json: () => res } as unknown as Response;

    await expect(
      handleWebhookRequest(req, res, {
        getTrigger: async (id) => {
          withProject(triggers, eq(triggers.id, id)); // real gate, no context → throws
          return ghTrigger(id);
        },
        getSecret: async () => null,
        fireTrigger: async () => "launched",
      }),
    ).rejects.toThrow(/no request context/i);
  });
});

describe("POST /api/github-events — real project-context path (getSecret)", () => {
  it("returns 200 for an HMAC-signed event — getSecret runs inside the system context", async () => {
    // A github trigger WITH a secret: getSecret → withProject was previously
    // unwrapped and 500'd. The signed body must pass HMAC, then fire.
    const secret = "webhook-secret-key";
    const fire = vi.fn(async () => "launched");
    const app = buildApp({ trigger: ghTrigger("trig-gh-1", "enc"), secret, fireTrigger: fire });

    const bodyObj = { action: "opened", number: 2, repository: { full_name: "acme/widget" } };
    const jsonString = JSON.stringify(bodyObj);
    const raw = Buffer.from(jsonString, "utf8");
    const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

    const res = await request(app)
      .post("/api/github-events")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "pull_request")
      .set("X-Hub-Signature-256", sig)
      .send(jsonString); // exact bytes → req.rawBody matches the signed payload

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fired: 1 });
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
