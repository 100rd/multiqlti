/**
 * Integration tests for graceful degradation (Security C1 — never 500 the user).
 * Covers: Omniscience disabled (backend=local) → 200 with internalDegraded=true
 * and external items still present; Omniscience unreachable (board throws) →
 * 200 degraded; internal search outage → 200 degraded; gateway failure →
 * the brief is 'failed' but the request still returns 200 (not a transport 500).
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createNewsTestApp } from "../../helpers/test-news-app";

const base = (ws: string) => `/api/workspaces/${ws}/news`;

describe("degraded modes", () => {
  it("Omniscience disabled (backend=local) → 200, internalDegraded on brief AND meta, external items present, no 500", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true, boardDisabled: true });
    const res = await request(app).get(`${base(workspaceId)}/brief`);
    expect(res.status).toBe(200);
    expect(res.body.data.brief.internalDegraded).toBe(true);
    expect(res.body.meta.internalDegraded).toBe(true);
    expect(res.body.data.brief.status).toBe("ready");
    expect(res.body.data.items.some((i: { category: string }) => i.category === "external")).toBe(true);
  });

  it("Omniscience unreachable (board throws) → 200, internalDegraded", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true, boardProviderFails: true });
    const res = await request(app).get(`${base(workspaceId)}/brief`);
    expect(res.status).toBe(200);
    expect(res.body.meta.internalDegraded).toBe(true);
  });

  it("internal search outage → 200, internalDegraded, external still ships", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true, embedFails: true });
    const res = await request(app).get(`${base(workspaceId)}/brief`);
    expect(res.status).toBe(200);
    expect(res.body.meta.internalDegraded).toBe(true);
    expect(res.body.data.items.some((i: { category: string }) => i.category === "external")).toBe(true);
  });

  it("gateway failure → brief 'failed', request still 200 (not a 500)", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true, gatewayFails: true });
    const res = await request(app).get(`${base(workspaceId)}/brief`);
    expect(res.status).toBe(200);
    expect(res.body.data.brief.status).toBe("failed");
  });

  it("never leaks a raw Omniscience error envelope to the client", async () => {
    const { app, workspaceId } = await createNewsTestApp({ ownsWorkspace: true, boardProviderFails: true });
    const res = await request(app).get(`${base(workspaceId)}/brief`);
    const payload = JSON.stringify(res.body);
    expect(payload).not.toMatch(/forbidden:/);
    expect(payload).not.toMatch(/workspace token/i);
  });
});
