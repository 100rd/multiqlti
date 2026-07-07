/**
 * Integration tests for GET /api/activity — the read-only Live Activity lens.
 *
 * Covers: 401 unauth; admin sees all active groups (incl. ownerless) with
 * ownerId per row; the payload is METADATA-ONLY (no transcript/output/
 * decisionText/reasoning/prompt); and the row cap truncates + logs.
 *
 * Owner-scoping / per-group visibility is covered in live-task-group.test.ts;
 * this file focuses on the categories that one doesn't: auth, the
 * multi-owner admin view, strict field-shape, and the row cap.
 *
 * supertest over MemStorage with a stub task orchestrator whose
 * getActiveGroupIds() drives the candidate set. No CLI / network / real DB.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import type { Router } from "express";
import { MemStorage } from "../../../server/storage.js";
import { registerActivityRoutes } from "../../../server/routes/activity.js";
import type { ActivityRouteDeps } from "../../../server/routes/activity.js";
import type { User, UserRole } from "../../../shared/types.js";
import type { InsertTaskGroup, InsertTask } from "@shared/schema";

afterEach(() => vi.restoreAllMocks());

interface BuildOpts {
  userId?: string;
  role?: UserRole;
  noUser?: boolean;
  activeGroupIds?: string[];
}

function buildApp(storage: MemStorage, opts: BuildOpts = {}) {
  const deps: ActivityRouteDeps = {
    taskOrchestrator: { getActiveGroupIds: () => opts.activeGroupIds ?? [] },
  };

  const user: User = {
    id: opts.noUser ? (undefined as unknown as string) : opts.userId ?? "owner",
    email: "a@x.com",
    name: "A",
    isActive: true,
    role: opts.role ?? "user",
    lastLoginAt: null,
    createdAt: new Date(0),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.noUser) req.user = undefined as never;
    else req.user = user;
    next();
  });
  registerActivityRoutes(app as unknown as Router, storage, deps);
  return app;
}

/** Seed a running task group + a running task. Returns the groupId. */
async function seedGroup(
  storage: MemStorage,
  createdBy: string | null,
): Promise<string> {
  const group = await storage.createTaskGroup({
    name: "SECRET GROUP NAME",
    description: "secret desc",
    input: "SECRET TASK TEXT do not leak",
    status: "running",
    createdBy,
    startedAt: new Date(),
  } as InsertTaskGroup);
  await storage.createTask({
    groupId: group.id,
    name: "secret task name",
    description: "secret task desc",
    executionMode: "direct_llm",
    dependsOn: [],
    input: { secret: "stage prompt should never appear" },
    status: "running",
    sortOrder: 0,
    modelSlug: "claude-sonnet",
  } as InsertTask);
  return group.id;
}

describe("GET /api/activity — auth", () => {
  it("401 when unauthenticated", async () => {
    const storage = new MemStorage();
    const app = buildApp(storage, { noUser: true });
    const res = await request(app).get("/api/activity");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/activity — admin scoping", () => {
  it("admin sees ALL active groups (incl. ownerless) with ownerId per row", async () => {
    const storage = new MemStorage();
    const a = await seedGroup(storage, "owner");
    const b = await seedGroup(storage, "someone-else");
    const c = await seedGroup(storage, null);

    const app = buildApp(storage, {
      userId: "boss",
      role: "admin",
      activeGroupIds: [a, b, c],
    });
    const res = await request(app).get("/api/activity");
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.runs).toHaveLength(3);
    const owners = res.body.runs.map((r: { ownerId: string | null }) => r.ownerId).sort();
    expect(owners).toEqual([null, "owner", "someone-else"]);
  });
});

describe("GET /api/activity — metadata-only (security)", () => {
  it("leaks NO name/description/input/reasoning/task text", async () => {
    const storage = new MemStorage();
    const id = await seedGroup(storage, "owner");

    const app = buildApp(storage, {
      userId: "owner",
      role: "admin",
      activeGroupIds: [id],
    });
    const res = await request(app).get("/api/activity");
    const serialized = JSON.stringify(res.body);

    // No free-text / sensitive field names or values anywhere in the payload.
    for (const banned of [
      "SECRET GROUP NAME",
      "secret desc",
      "SECRET TASK TEXT",
      "secret task name",
      "stage prompt should never appear",
    ]) {
      expect(serialized).not.toContain(banned);
    }

    // Positive: each row exposes only the metadata keys.
    for (const row of res.body.runs) {
      expect(Object.keys(row).sort()).toEqual(
        ["currentUnit", "mode", "ownerId", "runId", "startedAt", "status", "title", "workspaceId"].sort(),
      );
      if (row.currentUnit) {
        expect(Object.keys(row.currentUnit).sort()).toEqual(
          ["agent", "label", "modelSlug", "status"].sort(),
        );
      }
    }
  });
});

describe("GET /api/activity — row cap", () => {
  it("truncates + logs when the candidate set exceeds the cap", async () => {
    const storage = new MemStorage();
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) ids.push(await seedGroup(storage, "owner"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const app = buildApp(storage, {
      userId: "owner",
      role: "user",
      activeGroupIds: ids,
    });
    const res = await request(app).get("/api/activity");
    expect(res.body.runs.length).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
