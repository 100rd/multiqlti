/**
 * Integration tests for POST /news/refresh.
 * Covers: 202 with briefId, regeneration counts toward the daily cap, rate-limit
 * 429 once the cap is exceeded, date validation, owner/role gate, workspace 404.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createNewsTestApp } from "../../helpers/test-news-app";
import { MAX_GENERATIONS_PER_DAY } from "../../../server/news/brief-scheduler";

const base = (ws: string) => `/api/workspaces/${ws}/news`;

describe("POST /news/refresh", () => {
  it("returns 202 with a briefId", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).post(`${base(workspaceId)}/refresh`).send({});
    expect(res.status).toBe(202);
    expect(typeof res.body.data.briefId).toBe("string");
  });

  it("enforces the per-day generation rate limit with a clean 429 JSON error", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    // First GET auto-generates (genCount=1). Then refreshes consume the rest.
    await request(app).get(`${base(workspaceId)}/brief`);
    let lastRes;
    for (let i = 0; i < MAX_GENERATIONS_PER_DAY + 2; i++) {
      lastRes = await request(app).post(`${base(workspaceId)}/refresh`).send({});
    }
    expect(lastRes!.status).toBe(429);
    // Clean JSON the FE can render; no internal/Omniscience leakage.
    expect(typeof lastRes!.body.error).toBe("string");
    expect(JSON.stringify(lastRes!.body)).not.toMatch(/forbidden:|RateLimitError|stack/i);
  });

  it("400s on a malformed date", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).post(`${base(workspaceId)}/refresh`).send({ date: "june" });
    expect(res.status).toBe(400);
  });

  it("403s a non-owner without a qualifying role", async () => {
    const { app, workspaceId } = await createNewsTestApp({ role: "viewer" as never, ownsWorkspace: false });
    const res = await request(app).post(`${base(workspaceId)}/refresh`).send({});
    expect(res.status).toBe(403);
  });

  it("404s for an unknown workspace", async () => {
    const { app } = await createNewsTestApp({ ownsWorkspace: true });
    const res = await request(app).post(`${base("nope")}/refresh`).send({});
    expect(res.status).toBe(404);
  });
});
