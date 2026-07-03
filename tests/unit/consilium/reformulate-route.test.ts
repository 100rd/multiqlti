/**
 * reformulate-route.test.ts - POST /api/consilium-reviews/reformulate-instruction.
 *
 * The "magic mode" endpoint: it validates the body, honours the
 * consiliumLoop.reformulate kill-switch (+ a wired gateway), and delegates the
 * single model call to the reformulate service. Here we drive the route end-to-end
 * with a FAKE gateway (no real LLM), asserting:
 *   - a valid body returns 200 with a proposedInstruction;
 *   - an empty/whitespace rawWant is a clean 400 BEFORE any model call (zod gate);
 *   - the kill-switch off (or no gateway) is a 409 (manual mode still works);
 *   - a gateway failure / empty proposal is a 502 (upstream problem, not the user).
 *
 * The service is NOT mocked - the full route -> service -> parse path runs, so this
 * also covers the untrusted-fencing + JSON-parse seam against a real code path.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { registerConsiliumReviewRoutes } from "../../../server/routes/consilium-reviews.js";
import type { ReformulateGateway } from "../../../server/services/consilium/reformulate.js";

type Opts = { enabled?: boolean; withGateway?: boolean; content?: string; throws?: boolean };

function fakeGateway(content: string, throws = false): { gateway: ReformulateGateway; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => {
    if (throws) throw new Error("gateway boom");
    return { content };
  });
  return { gateway: { completeStreaming: spy } as unknown as ReformulateGateway, spy };
}

function makeApp(opts: Opts = {}) {
  const { enabled = true, withGateway = true, content = '{"instruction":"Review strictly for security."}', throws = false } = opts;
  const { gateway, spy } = fakeGateway(content, throws);
  const app = express();
  app.use(express.json());
  // Stand in for requireAuth + requireProject (applied at mount in routes.ts).
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "user-1" };
    (req as unknown as { projectId: string }).projectId = "project-1";
    next();
  });
  registerConsiliumReviewRoutes(app, {
    // The create-path deps are unused by the reformulate endpoint.
    storage: {} as never,
    orchestrator: {} as never,
    controller: {} as never,
    config: () =>
      ({
        pipeline: {
          consiliumLoop: { reformulate: { enabled, model: "claude-opus" } },
          taskGroups: { taskTimeoutMs: 60000 },
        },
      }) as never,
    gateway: withGateway ? gateway : undefined,
  });
  return { app, spy };
}

const VALID = { rawWant: "make sure the new auth is safe and tested", repoPath: "/r/my-repo", preset: "sdlc-cross-review" as const };

describe("POST /api/consilium-reviews/reformulate-instruction", () => {
  it("returns 200 with a proposedInstruction for a valid body, calling the gateway once", async () => {
    const { app, spy } = makeApp();
    const res = await request(app).post("/api/consilium-reviews/reformulate-instruction").send(VALID);
    expect(res.status).toBe(200);
    expect(res.body.proposedInstruction).toMatch(/security/i);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty rawWant with 400 BEFORE any model call (zod min after trim)", async () => {
    for (const rawWant of ["", "   ", "\n\t"]) {
      const { app, spy } = makeApp();
      const res = await request(app)
        .post("/api/consilium-reviews/reformulate-instruction")
        .send({ ...VALID, rawWant });
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("rejects an unknown preset with 400 before any model call", async () => {
    const { app, spy } = makeApp();
    const res = await request(app)
      .post("/api/consilium-reviews/reformulate-instruction")
      .send({ ...VALID, preset: "not-a-preset" });
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 409 when the reformulate kill-switch is off (manual mode still works)", async () => {
    const { app, spy } = makeApp({ enabled: false });
    const res = await request(app).post("/api/consilium-reviews/reformulate-instruction").send(VALID);
    expect(res.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 409 when no gateway is wired", async () => {
    const { app } = makeApp({ withGateway: false });
    const res = await request(app).post("/api/consilium-reviews/reformulate-instruction").send(VALID);
    expect(res.status).toBe(409);
  });

  it("returns 502 when the gateway throws (upstream problem, generic message)", async () => {
    const { app } = makeApp({ throws: true });
    const res = await request(app).post("/api/consilium-reviews/reformulate-instruction").send(VALID);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/could not reformulate/i);
    // No model internals leaked.
    expect(res.body.error).not.toMatch(/boom/i);
  });

  it("returns 502 when the model returns an empty proposal", async () => {
    const { app } = makeApp({ content: "   " });
    const res = await request(app).post("/api/consilium-reviews/reformulate-instruction").send(VALID);
    expect(res.status).toBe(502);
  });

  it("still surfaces a proposal when the model wraps it in prose (tolerant parse)", async () => {
    const { app } = makeApp({ content: 'Sure, here you go:\n{"instruction":"Focus on tests and threat model."}\nGood luck' });
    const res = await request(app).post("/api/consilium-reviews/reformulate-instruction").send(VALID);
    expect(res.status).toBe(200);
    expect(res.body.proposedInstruction).toBe("Focus on tests and threat model.");
  });
});
