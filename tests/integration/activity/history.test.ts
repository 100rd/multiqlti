/**
 * Integration tests for GET /api/activity/history — the DB-backed History tab.
 *
 * Covers (H1/H4): 401 unauth; owner sees only their own groups
 * (task_groups.createdBy); admin sees all + ownerId; terminal-status only
 * (running/pending excluded); METADATA-ONLY exact-key allowlist + a
 * banned-string scan (no input/output/summary/transcript leak, fixed title
 * not the group name); keyset pagination; limit clamp to 100; malformed
 * cursor → 400.
 *
 * supertest over MemStorage. No CLI / network / real DB.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import type { Router } from "express";
import { MemStorage } from "../../../server/storage.js";
import { registerActivityRoutes } from "../../../server/routes/activity.js";
import type { ActivityRouteDeps } from "../../../server/routes/activity.js";
import type { User, UserRole } from "../../../shared/types.js";
import type { InsertTaskGroup, InsertTask } from "@shared/schema";

function buildApp(storage: MemStorage, opts: { userId?: string; role?: UserRole; noUser?: boolean } = {}) {
  const deps: ActivityRouteDeps = {
    taskOrchestrator: { getActiveGroupIds: () => [] },
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

async function seedTaskGroup(
  storage: MemStorage,
  createdBy: string | null,
  status: string,
  completedAt: Date | null,
) {
  const group = await storage.createTaskGroup({
    name: "SUPER SECRET GROUP NAME",
    description: "secret description leak test",
    input: "SECRET GROUP INPUT leak test",
    status,
    createdBy,
    startedAt: completedAt ? new Date(completedAt.getTime() - 1000) : new Date(),
    completedAt,
  } as InsertTaskGroup);
  await storage.createTask({
    groupId: group.id,
    name: "secret task name leak",
    description: "secret task desc leak",
    executionMode: "direct_llm",
    dependsOn: [],
    input: { secret: "task input leak" },
    summary: "SECRET TASK SUMMARY leak",
    status: "completed",
    sortOrder: 0,
    modelSlug: "claude-sonnet",
  } as InsertTask);
  return group;
}

describe("GET /api/activity/history — auth + scoping", () => {
  it("401 when unauthenticated", async () => {
    const storage = new MemStorage();
    const res = await request(buildApp(storage, { noUser: true })).get("/api/activity/history");
    expect(res.status).toBe(401);
  });

  it("non-admin sees only their own", async () => {
    const storage = new MemStorage();
    await seedTaskGroup(storage, "me", "completed", new Date("2026-01-01T00:00:00Z"));
    await seedTaskGroup(storage, "other", "completed", new Date("2026-01-02T00:00:00Z"));

    const res = await request(buildApp(storage, { userId: "me" })).get("/api/activity/history");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.isAdmin).toBe(false);
    // No ownerId for non-admins.
    for (const item of res.body.items) expect(item.ownerId).toBeUndefined();
  });

  it("admin sees all + ownerId attribution", async () => {
    const storage = new MemStorage();
    await seedTaskGroup(storage, "me", "completed", new Date("2026-01-01T00:00:00Z"));
    await seedTaskGroup(storage, "other", "completed", new Date("2026-01-03T00:00:00Z"));
    const res = await request(buildApp(storage, { userId: "boss", role: "admin" })).get(
      "/api/activity/history",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.items.some((i: { ownerId?: string }) => i.ownerId === "other")).toBe(true);
  });
});

describe("GET /api/activity/history — terminal-only", () => {
  it("excludes running and pending groups", async () => {
    const storage = new MemStorage();
    await seedTaskGroup(storage, "me", "running", null);
    await seedTaskGroup(storage, "me", "pending", null);
    await seedTaskGroup(storage, "me", "cancelled", new Date("2026-01-02T00:00:00Z"));
    await seedTaskGroup(storage, "me", "completed", new Date("2026-01-01T00:00:00Z"));

    const res = await request(buildApp(storage, { userId: "me" })).get("/api/activity/history");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const statuses = res.body.items.map((i: { status: string }) => i.status).sort();
    expect(statuses).toEqual(["cancelled", "completed"]);
  });
});

describe("GET /api/activity/history — metadata-only allowlist", () => {
  it("exposes only the allowlisted keys and no banned strings", async () => {
    const storage = new MemStorage();
    await seedTaskGroup(storage, "me", "completed", new Date("2026-01-01T00:00:00Z"));
    await seedTaskGroup(storage, "me", "completed", new Date("2026-01-02T00:00:00Z"));

    const res = await request(buildApp(storage, { userId: "boss", role: "admin" })).get(
      "/api/activity/history",
    );
    expect(res.status).toBe(200);

    const allowedKeys = new Set([
      "runId",
      "mode",
      "title",
      "status",
      "startedAt",
      "completedAt",
      "currentUnit",
      "workspaceId",
      "ownerId",
    ]);
    const allowedUnitKeys = new Set(["label", "agent", "modelSlug", "status"]);
    for (const item of res.body.items) {
      for (const key of Object.keys(item)) expect(allowedKeys.has(key)).toBe(true);
      if (item.currentUnit) {
        for (const key of Object.keys(item.currentUnit)) {
          expect(allowedUnitKeys.has(key)).toBe(true);
        }
      }
    }

    // Banned-string scan over the entire serialized payload.
    const serialized = JSON.stringify(res.body);
    const banned = [
      "SUPER SECRET GROUP NAME",
      "secret description",
      "SECRET GROUP INPUT",
      "secret task name",
      "SECRET TASK SUMMARY",
      "task input leak",
    ];
    for (const b of banned) expect(serialized).not.toContain(b);

    // Title is the FIXED label, never the group name.
    const group = res.body.items.find((i: { mode: string }) => i.mode === "task_group");
    expect(group.title).toBe("Task group");
  });
});

describe("GET /api/activity/history — pagination", () => {
  it("paginates by keyset cursor without overlap", async () => {
    const storage = new MemStorage();
    for (let i = 0; i < 5; i++) {
      await seedTaskGroup(
        storage,
        "me",
        "completed",
        new Date(`2026-01-0${i + 1}T00:00:00Z`),
      );
    }
    const app = buildApp(storage, { userId: "me" });

    const first = await request(app).get("/api/activity/history?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app).get(
      `/api/activity/history?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.body.items).toHaveLength(2);

    const firstIds = new Set(first.body.items.map((i: { runId: string }) => i.runId));
    for (const item of second.body.items) {
      expect(firstIds.has(item.runId)).toBe(false);
    }
    // Newest first.
    expect(first.body.items[0].completedAt > first.body.items[1].completedAt).toBe(true);
  });

  it("rejects limit above the 100 bound with 400 (no unbounded query)", async () => {
    const storage = new MemStorage();
    await seedTaskGroup(storage, "me", "completed", new Date("2026-01-01T00:00:00Z"));
    const res = await request(buildApp(storage, { userId: "me" })).get(
      "/api/activity/history?limit=99999",
    );
    expect(res.status).toBe(400);
  });

  it("accepts limit=100 exactly", async () => {
    const storage = new MemStorage();
    await seedTaskGroup(storage, "me", "completed", new Date("2026-01-01T00:00:00Z"));
    const res = await request(buildApp(storage, { userId: "me" })).get(
      "/api/activity/history?limit=100",
    );
    expect(res.status).toBe(200);
  });

  it("rejects a malformed cursor with 400", async () => {
    const storage = new MemStorage();
    const res = await request(buildApp(storage, { userId: "me" })).get(
      "/api/activity/history?cursor=not-a-valid-cursor",
    );
    expect(res.status).toBe(400);
  });

  it("accepts mode=task_group and returns only task_group rows", async () => {
    const storage = new MemStorage();
    await seedTaskGroup(storage, "me", "completed", new Date("2026-01-02T00:00:00Z"));
    const res = await request(buildApp(storage, { userId: "me" })).get(
      "/api/activity/history?mode=task_group",
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].mode).toBe("task_group");
  });

  it("rejects an unknown mode with 400", async () => {
    const storage = new MemStorage();
    const res = await request(buildApp(storage, { userId: "me" })).get(
      "/api/activity/history?mode=pipeline",
    );
    expect(res.status).toBe(400);
  });
});
