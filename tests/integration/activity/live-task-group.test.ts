/**
 * Integration tests for task-groups as the FIFTH live Activity mode.
 *
 * GET /api/activity unions the controllers' active run ids with the task
 * orchestrator's getActiveGroupIds(). A live group row is owner-scoped via
 * task_groups.createdBy, metadata-only, with a FIXED title (never the group
 * name) and a currentUnit derived from the running/last task.
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

function buildApp(
  storage: MemStorage,
  opts: { userId?: string; role?: UserRole; activeGroupIds?: string[] } = {},
) {
  const deps: ActivityRouteDeps = {
    taskOrchestrator: { getActiveGroupIds: () => opts.activeGroupIds ?? [] },
  };
  const user: User = {
    id: opts.userId ?? "owner",
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
    req.user = user;
    next();
  });
  registerActivityRoutes(app as unknown as Router, storage, deps);
  return app;
}

async function seedRunningGroup(storage: MemStorage, createdBy: string | null) {
  const group = await storage.createTaskGroup({
    name: "SECRET LIVE GROUP NAME",
    description: "secret live desc",
    input: "secret live input",
    status: "running",
    createdBy,
    startedAt: new Date(),
  } as InsertTaskGroup);
  await storage.createTask({
    groupId: group.id,
    name: "secret live task name",
    description: "secret live task desc",
    executionMode: "direct_llm",
    dependsOn: [],
    input: { secret: "live task input" },
    status: "running",
    sortOrder: 0,
    modelSlug: "claude-sonnet",
  } as InsertTask);
  return group;
}

describe("GET /api/activity — task_group as the fifth live mode", () => {
  it("shows the owner's running group with metadata-only fields", async () => {
    const storage = new MemStorage();
    const group = await seedRunningGroup(storage, "owner");
    const res = await request(
      buildApp(storage, { userId: "owner", activeGroupIds: [group.id] }),
    ).get("/api/activity");

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    const row = res.body.runs[0];
    expect(row.mode).toBe("task_group");
    expect(row.title).toBe("Task group");
    expect(row.runId).toBe(group.id);
    expect(row.currentUnit.agent).toBe("direct_llm"); // executionMode, not text
    expect(row.currentUnit.modelSlug).toBe("claude-sonnet");

    // No banned strings anywhere.
    const serialized = JSON.stringify(res.body);
    for (const b of [
      "SECRET LIVE GROUP NAME",
      "secret live desc",
      "secret live input",
      "secret live task name",
    ]) {
      expect(serialized).not.toContain(b);
    }
  });

  it("hides another user's running group from a non-admin", async () => {
    const storage = new MemStorage();
    const group = await seedRunningGroup(storage, "someone-else");
    const res = await request(
      buildApp(storage, { userId: "me", activeGroupIds: [group.id] }),
    ).get("/api/activity");
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(0);
  });

  it("hides an ownerless running group from a non-admin but shows it to an admin", async () => {
    const storage = new MemStorage();
    const group = await seedRunningGroup(storage, null);

    const nonAdmin = await request(
      buildApp(storage, { userId: "me", activeGroupIds: [group.id] }),
    ).get("/api/activity");
    expect(nonAdmin.body.runs).toHaveLength(0);

    const adminRes = await request(
      buildApp(storage, { userId: "boss", role: "admin", activeGroupIds: [group.id] }),
    ).get("/api/activity");
    expect(adminRes.body.runs).toHaveLength(1);
    expect(adminRes.body.runs[0].ownerId).toBe(null);
  });
});
