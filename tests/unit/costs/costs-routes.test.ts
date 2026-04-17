/**
 * Tests for server/routes/costs.ts
 * Covers: GET /costs/summary, GET /costs/export, GET/POST/PATCH/DELETE /budgets
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { MemStorage } from "../../../server/storage.js";
import { registerCostRoutes } from "../../../server/routes/costs.js";
import type { InsertBudget } from "../../../shared/schema.js";

// ─── Test app factory ─────────────────────────────────────────────────────────

function makeApp(storage: MemStorage) {
  const app = express();
  app.use(express.json());
  registerCostRoutes(app, storage);
  return app;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WS_ID = "ws-test-1";

async function createWorkspace(storage: MemStorage, id = WS_ID) {
  return storage.createWorkspace({
    id,
    name: "Test Workspace",
    type: "local",
    path: "/tmp/test",
    branch: "main",
    status: "active",
    indexStatus: "idle",
  });
}

async function createBudget(
  storage: MemStorage,
  overrides: Partial<InsertBudget> = {},
) {
  return storage.createBudget({
    workspaceId: WS_ID,
    provider: null,
    period: "month",
    limitUsd: 10.0,
    hard: false,
    notifyAtPct: [50, 80, 100],
    ...overrides,
  });
}

// ─── GET /costs/summary ───────────────────────────────────────────────────────

describe("GET /api/workspaces/:id/costs/summary", () => {
  it("1. 404 when workspace not found", async () => {
    const storage = makeStorage();
    const app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/nonexistent/costs/summary");
    expect(res.status).toBe(404);
  });

  it("2. 400 for invalid period parameter", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/costs/summary?period=year`);
    expect(res.status).toBe(400);
  });

  it("3. 200 with valid workspace and period=month", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/costs/summary?period=month`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("period", "month");
    expect(res.body).toHaveProperty("totalCostUsd");
    expect(res.body).toHaveProperty("dailySeries");
    expect(res.body).toHaveProperty("byProvider");
    expect(res.body).toHaveProperty("budgetStatuses");
  });

  it("4. defaults period to month when not specified", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/costs/summary`);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("month");
  });

  it("5. returns summary for period=day", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/costs/summary?period=day`);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("day");
  });

  it("6. returns summary for period=week", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/costs/summary?period=week`);
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("week");
  });
});

// ─── GET /costs/export ───────────────────────────────────────────────────────

describe("GET /api/workspaces/:id/costs/export", () => {
  it("7. 404 when workspace not found", async () => {
    const storage = makeStorage();
    const app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/nonexistent/costs/export");
    expect(res.status).toBe(404);
  });

  it("8. returns CSV content-type", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/costs/export`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
  });

  it("9. Content-Disposition header is attachment with filename", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/costs/export?period=week`);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toMatch(/costs-/);
    expect(res.headers["content-disposition"]).toMatch(/week/);
  });

  it("10. empty workspace returns header-only CSV", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/costs/export`);
    expect(res.text.trim()).toContain("ts,provider,model");
    expect(res.text.split("\n")).toHaveLength(1);
  });
});

// ─── GET /budgets ─────────────────────────────────────────────────────────────

describe("GET /api/workspaces/:id/budgets", () => {
  it("11. 404 when workspace not found", async () => {
    const storage = makeStorage();
    const app = makeApp(storage);
    const res = await request(app).get("/api/workspaces/nonexistent/budgets");
    expect(res.status).toBe(404);
  });

  it("12. returns empty array when no budgets exist", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/budgets`);
    expect(res.status).toBe(200);
    expect(res.body.budgets).toEqual([]);
  });

  it("13. returns created budgets", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    await createBudget(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/budgets`);
    expect(res.status).toBe(200);
    expect(res.body.budgets).toHaveLength(1);
    expect(res.body.budgets[0]).toHaveProperty("limitUsd", 10.0);
  });
});

// ─── POST /budgets ────────────────────────────────────────────────────────────

describe("POST /api/workspaces/:id/budgets", () => {
  it("14. 404 when workspace not found", async () => {
    const storage = makeStorage();
    const app = makeApp(storage);
    const res = await request(app)
      .post("/api/workspaces/nonexistent/budgets")
      .send({ limitUsd: 5.0, period: "month", hard: false });
    expect(res.status).toBe(404);
  });

  it("15. 400 for missing limitUsd", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/budgets`)
      .send({ period: "month" });
    expect(res.status).toBe(400);
  });

  it("16. 400 for invalid period", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/budgets`)
      .send({ limitUsd: 5.0, period: "quarter" });
    expect(res.status).toBe(400);
  });

  it("17. 201 with valid body — provider=null (all providers)", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/budgets`)
      .send({ limitUsd: 5.0, period: "month", hard: true, notifyAtPct: [80, 100] });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body.limitUsd).toBe(5.0);
    expect(res.body.hard).toBe(true);
    expect(res.body.notifyAtPct).toEqual([80, 100]);
  });

  it("18. 201 with provider-specific budget", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app)
      .post(`/api/workspaces/${WS_ID}/budgets`)
      .send({ limitUsd: 3.0, period: "day", provider: "anthropic" });
    expect(res.status).toBe(201);
    expect(res.body.provider).toBe("anthropic");
  });
});

// ─── GET /budgets/:budgetId ───────────────────────────────────────────────────

describe("GET /api/workspaces/:id/budgets/:budgetId", () => {
  it("19. 404 for unknown budget", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/budgets/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("20. 404 when budget belongs to different workspace", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    await createWorkspace(storage, "ws-other");
    const budget = await createBudget(storage, { workspaceId: "ws-other" });
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/budgets/${budget.id}`);
    expect(res.status).toBe(404);
  });

  it("21. 200 for existing budget", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const budget = await createBudget(storage);
    const app = makeApp(storage);
    const res = await request(app).get(`/api/workspaces/${WS_ID}/budgets/${budget.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(budget.id);
  });
});

// ─── PATCH /budgets/:budgetId ─────────────────────────────────────────────────

describe("PATCH /api/workspaces/:id/budgets/:budgetId", () => {
  it("22. 404 for unknown budget", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/budgets/nonexistent`)
      .send({ limitUsd: 20.0 });
    expect(res.status).toBe(404);
  });

  it("23. 400 for invalid period update", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const budget = await createBudget(storage);
    const app = makeApp(storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/budgets/${budget.id}`)
      .send({ period: "quarter" });
    expect(res.status).toBe(400);
  });

  it("24. 200 — partial update of limitUsd only", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const budget = await createBudget(storage);
    const app = makeApp(storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/budgets/${budget.id}`)
      .send({ limitUsd: 25.0 });
    expect(res.status).toBe(200);
    expect(res.body.limitUsd).toBe(25.0);
    expect(res.body.hard).toBe(false); // unchanged
  });

  it("25. 200 — update hard=true", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const budget = await createBudget(storage);
    const app = makeApp(storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WS_ID}/budgets/${budget.id}`)
      .send({ hard: true });
    expect(res.status).toBe(200);
    expect(res.body.hard).toBe(true);
  });
});

// ─── DELETE /budgets/:budgetId ────────────────────────────────────────────────

describe("DELETE /api/workspaces/:id/budgets/:budgetId", () => {
  it("26. 404 for unknown budget", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);
    const res = await request(app).delete(`/api/workspaces/${WS_ID}/budgets/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("27. 204 on successful delete", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const budget = await createBudget(storage);
    const app = makeApp(storage);
    const res = await request(app).delete(`/api/workspaces/${WS_ID}/budgets/${budget.id}`);
    expect(res.status).toBe(204);
  });

  it("28. budget not found after deletion", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const budget = await createBudget(storage);
    const app = makeApp(storage);
    await request(app).delete(`/api/workspaces/${WS_ID}/budgets/${budget.id}`);
    const checkRes = await request(app).get(`/api/workspaces/${WS_ID}/budgets/${budget.id}`);
    expect(checkRes.status).toBe(404);
  });

  it("29. 404 when budget belongs to different workspace (ownership check)", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    await createWorkspace(storage, "ws-other-del");
    const budget = await createBudget(storage, { workspaceId: "ws-other-del" });
    const app = makeApp(storage);
    const res = await request(app).delete(`/api/workspaces/${WS_ID}/budgets/${budget.id}`);
    expect(res.status).toBe(404);
  });
});

// ─── Budget CRUD end-to-end ───────────────────────────────────────────────────

describe("Budget CRUD integration", () => {
  it("30. create → list → patch → delete lifecycle", async () => {
    const storage = makeStorage();
    await createWorkspace(storage);
    const app = makeApp(storage);

    // Create
    const createRes = await request(app)
      .post(`/api/workspaces/${WS_ID}/budgets`)
      .send({ limitUsd: 5.0, period: "day", hard: false });
    expect(createRes.status).toBe(201);
    const id = createRes.body.id as string;

    // List
    const listRes = await request(app).get(`/api/workspaces/${WS_ID}/budgets`);
    expect(listRes.body.budgets).toHaveLength(1);

    // Patch
    const patchRes = await request(app)
      .patch(`/api/workspaces/${WS_ID}/budgets/${id}`)
      .send({ limitUsd: 20.0, hard: true });
    expect(patchRes.body.limitUsd).toBe(20.0);
    expect(patchRes.body.hard).toBe(true);

    // Delete
    const deleteRes = await request(app).delete(`/api/workspaces/${WS_ID}/budgets/${id}`);
    expect(deleteRes.status).toBe(204);

    // List again — empty
    const listRes2 = await request(app).get(`/api/workspaces/${WS_ID}/budgets`);
    expect(listRes2.body.budgets).toHaveLength(0);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeStorage(): MemStorage {
  return new MemStorage();
}
