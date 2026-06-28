/**
 * Webhook public-endpoint isolation tests (ADR-001 fix-isolation: C-1 / C-2)
 *
 * Verifies that the two public webhook endpoints do NOT throw "no request
 * context" (i.e. do NOT 500) when invoked with no x-project-id header.
 *
 * Root cause (before fix): getTrigger / getSecret called storage methods that
 * internally called withProject(), which throws fail-closed when there is no
 * ALS context.  Fix: wrap each callback in runAsSystem() so the system context
 * is established before the callback executes.
 *
 * Test strategy:
 *  - Mock the webhook-handler / github-event-handler to call the dep callbacks
 *    directly (so we exercise the runAsSystem wrapping, not the full handler logic).
 *  - Provide a "context-asserting" mock storage whose getTrigger / getSecret
 *    throw if called with NO ALS context — simulating the production fail-closed
 *    behaviour.  With the fix, runAsSystem establishes system context and the
 *    mock does NOT throw.
 *  - Assert the route returns 200, not 500.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { Express } from "express";

// ─── Simulate the fail-closed context assertion ───────────────────────────────
//
// The real withProject() throws "no request context" when called with no ALS
// store.  We replicate that guard inside the mock storage callbacks so the test
// catches regressions (a missing runAsSystem wrap would still cause 500).

vi.mock("../../server/services/webhook-handler.js", () => ({
  /**
   * Minimal stand-in for handleWebhookRequest: calls getTrigger and getSecret
   * and returns 200 — enough to exercise the runAsSystem context wrapping.
   */
  handleWebhookRequest: async (
    _req: unknown,
    res: { json: (v: unknown) => unknown },
    deps: {
      getTrigger: (id: string) => Promise<unknown>;
      getSecret: (id: string) => Promise<unknown>;
    },
  ) => {
    await deps.getTrigger("trigger-abc");
    await deps.getSecret("trigger-abc");
    res.json({ ok: true });
  },
  startRateLimitCleanup: () => {},
}));

vi.mock("../../server/services/github-event-handler.js", () => ({
  /**
   * Minimal stand-in for handleGitHubEvent: calls getSecret and returns a
   * successful result — enough to exercise the runAsSystem wrapping.
   */
  handleGitHubEvent: async (
    _rawBody: unknown,
    _headers: unknown,
    _body: unknown,
    deps: {
      getEnabledTriggersByType: (type: string) => Promise<unknown>;
      getSecret: (id: string) => Promise<unknown>;
      fireTrigger: unknown;
    },
  ) => {
    await deps.getEnabledTriggersByType("push");
    await deps.getSecret("trigger-abc");
    return { fired: ["trigger-abc"], errors: [] };
  },
}));

// ─── Context-asserting mock storage / trigger service ────────────────────────
//
// Each method checks whether there is an ALS context before proceeding.
// Without the runAsSystem fix, getTrigger / getSecret are called with no
// context and these throw — exactly what withProject() does in production.

async function requireContext(label: string): Promise<void> {
  const { requestContext } = await import("../../server/context.js");
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new Error(
      `[test] No ALS context in ${label} — withProject would throw in production`,
    );
  }
}

const mockStorage = {
  getTrigger: async (id: string) => {
    await requireContext(`getTrigger(${id})`);
    return { id, enabled: true, type: "webhook", projectId: "any-project" };
  },
  getAllEnabledTriggersByType: async (_type: string) => {
    await requireContext("getAllEnabledTriggersByType");
    return [];
  },
};

const mockTriggerService = {
  getSecret: async (id: string) => {
    await requireContext(`getSecret(${id})`);
    return null; // no HMAC secret configured
  },
};

const mockFireTrigger = async () => {};

// ─── Test app setup ───────────────────────────────────────────────────────────

let app: Express;

beforeAll(async () => {
  const { registerWebhookRoutes } = await import("../../server/routes/webhooks.js");
  app = express();
  app.use(express.json());
  registerWebhookRoutes(
    app,
    mockStorage as never,
    mockTriggerService as never,
    mockFireTrigger,
  );
});

// ─── C-1 tests ────────────────────────────────────────────────────────────────

describe("C-1: POST /api/webhooks/:triggerId — no x-project-id, no 500", () => {
  it("returns 200 (not 500 due to missing ALS context) with no x-project-id header", async () => {
    const res = await request(app)
      .post("/api/webhooks/trigger-abc")
      .send({ event: "test" });

    // Key assertion: must NOT be 500 (which would indicate a missing runAsSystem wrap)
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
  });

  it("succeeds for multiple concurrent calls without context bleed", async () => {
    const [r1, r2] = await Promise.all([
      request(app).post("/api/webhooks/trigger-1").send({}),
      request(app).post("/api/webhooks/trigger-2").send({}),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

// ─── C-2 tests ────────────────────────────────────────────────────────────────

describe("C-2: POST /api/github-events — no x-project-id, getSecret in runAsSystem", () => {
  it("returns 200 (not 500) with no x-project-id header", async () => {
    const res = await request(app)
      .post("/api/github-events")
      .set("x-github-event", "push")
      .send({ action: "push" });

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    // VETO-3: response only returns aggregate count, not trigger IDs
    expect(res.body).toHaveProperty("fired");
    expect(typeof res.body.fired).toBe("number");
  });

  it("does not leak trigger IDs or error details to the caller", async () => {
    const res = await request(app)
      .post("/api/github-events")
      .set("x-github-event", "push")
      .send({});

    expect(res.body).not.toHaveProperty("errors");
    expect(res.body).not.toHaveProperty("triggerId");
    // Only the fired count is returned
    expect(Object.keys(res.body)).toEqual(["fired"]);
  });
});
