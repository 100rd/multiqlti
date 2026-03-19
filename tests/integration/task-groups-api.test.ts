/**
 * Integration tests for Task Groups API (PR #167 + #169).
 *
 * Uses MemStorage + a mock TaskOrchestrator so no real pipeline execution occurs.
 * Verifies:
 * - GET  /api/task-groups            — list all groups (with task counts)
 * - GET  /api/task-groups/:id        — get single group with tasks
 * - POST /api/task-groups            — create group (delegates to orchestrator)
 * - POST /api/task-groups/:id/start  — start execution
 * - POST /api/task-groups/:id/cancel — cancel execution
 * - DELETE /api/task-groups/:id      — delete group
 * - POST /api/task-groups/:id/tasks/:taskId/retry — retry a failed task
 * - GET  /api/task-groups/:id/trace  — get trace waterfall (PR #169)
 *
 * Auth: all routes require req.user — synthetic admin is injected.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import type { Express } from "express";
import { MemStorage } from "../../server/storage.js";
import { registerTaskGroupRoutes } from "../../server/routes/task-groups.js";
import { registerTaskTraceRoutes } from "../../server/routes/task-traces.js";
import type { User } from "../../shared/types.js";
import type { TaskGroupRow, TaskRow, TaskTraceRow } from "../../shared/schema.js";

// ─── Synthetic admin ──────────────────────────────────────────────────────────

const TEST_ADMIN: User = {
  id: "user-test-1",
  email: "admin@test.com",
  name: "Test Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// ─── Mock orchestrator ────────────────────────────────────────────────────────

function makeMockOrchestrator(storage: MemStorage) {
  return {
    createTaskGroup: vi.fn(
      async (data: { name: string; description: string; input: string; createdBy?: string; tasks: Array<{ name: string; description: string }> }) => {
        const group = await storage.createTaskGroup({
          name: data.name,
          description: data.description,
          input: data.input,
          createdBy: data.createdBy ?? null,
        });
        const tasks: TaskRow[] = [];
        for (let i = 0; i < data.tasks.length; i++) {
          const t = await storage.createTask({
            groupId: group.id,
            name: data.tasks[i].name,
            description: data.tasks[i].description,
            sortOrder: i,
          });
          tasks.push(t);
        }
        return { group, tasks };
      },
    ),
    startGroup: vi.fn(async (groupId: string) => {
      await storage.updateTaskGroup(groupId, { status: "running" });
    }),
    cancelGroup: vi.fn(async (groupId: string) => {
      await storage.updateTaskGroup(groupId, { status: "cancelled" });
    }),
    retryTask: vi.fn(async (taskId: string) => {
      await storage.updateTask(taskId, { status: "pending" });
    }),
  };
}

// ─── App factory ─────────────────────────────────────────────────────────────

async function createTestApp() {
  const storage = new MemStorage();
  const orchestrator = makeMockOrchestrator(storage);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN;
    next();
  });

  // Task Groups routes take a Router — pass app directly (Express is a Router)
  registerTaskGroupRoutes(app as unknown as import("express").Router, storage, orchestrator as unknown as import("../../server/services/task-orchestrator.js").TaskOrchestrator);
  registerTaskTraceRoutes(app, storage);

  const httpServer = createServer(app);
  return {
    app,
    storage,
    orchestrator,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Task Groups API", () => {
  let app: Express;
  let storage: MemStorage;
  let orchestrator: ReturnType<typeof makeMockOrchestrator>;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    storage = ctx.storage;
    orchestrator = ctx.orchestrator;
    closeApp = ctx.close;
  }, 15_000);

  afterAll(async () => {
    await closeApp();
  });

  // ─── GET /api/task-groups ─────────────────────────────────────────────────

  describe("GET /api/task-groups", () => {
    it("returns 200 with empty array when no groups exist", async () => {
      const res = await request(app).get("/api/task-groups");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns groups with taskCount and completedCount properties", async () => {
      // Create a group with tasks directly in storage
      const group = await storage.createTaskGroup({
        name: "Count Test Group",
        description: "Testing counts",
        input: "test input",
        createdBy: TEST_ADMIN.id,
      });
      await storage.createTask({ groupId: group.id, name: "Task 1", description: "d1", sortOrder: 0 });
      const t2 = await storage.createTask({ groupId: group.id, name: "Task 2", description: "d2", sortOrder: 1 });
      await storage.updateTask(t2.id, { status: "completed" });

      const res = await request(app).get("/api/task-groups");
      expect(res.status).toBe(200);
      const groups = res.body as Array<{ id: string; taskCount: number; completedCount: number }>;
      const found = groups.find((g) => g.id === group.id);
      expect(found).toBeDefined();
      expect(found?.taskCount).toBe(2);
      expect(found?.completedCount).toBe(1);
    });
  });

  // ─── GET /api/task-groups/:id ─────────────────────────────────────────────

  describe("GET /api/task-groups/:id", () => {
    it("returns 404 for unknown group id", async () => {
      const res = await request(app).get("/api/task-groups/nonexistent-id");
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toBeTruthy();
    });

    it("returns 200 with group and tasks array for known id", async () => {
      const group = await storage.createTaskGroup({
        name: "Detail Group",
        description: "For detail test",
        input: "input text",
        createdBy: TEST_ADMIN.id,
      });
      await storage.createTask({ groupId: group.id, name: "Sub-task A", description: "desc", sortOrder: 0 });

      const res = await request(app).get(`/api/task-groups/${group.id}`);
      expect(res.status).toBe(200);
      const body = res.body as { id: string; tasks: TaskRow[] };
      expect(body.id).toBe(group.id);
      expect(Array.isArray(body.tasks)).toBe(true);
      expect(body.tasks).toHaveLength(1);
    });
  });

  // ─── POST /api/task-groups ────────────────────────────────────────────────

  describe("POST /api/task-groups", () => {
    it("returns 201 with created group on valid payload", async () => {
      orchestrator.createTaskGroup.mockClear();
      const payload = {
        name: "My Feature Group",
        description: "Implement auth module end-to-end",
        input: "Add user authentication with JWT tokens",
        tasks: [
          { name: "Backend API", description: "Write auth endpoints" },
          { name: "Frontend", description: "Build login UI" },
        ],
      };

      const res = await request(app).post("/api/task-groups").send(payload);
      expect(res.status).toBe(201);
      const body = res.body as { name: string; tasks: TaskRow[] };
      expect(body.name).toBe("My Feature Group");
      expect(Array.isArray(body.tasks)).toBe(true);
      expect(orchestrator.createTaskGroup).toHaveBeenCalledOnce();
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(app).post("/api/task-groups").send({
        description: "Missing name",
        input: "some input",
        tasks: [{ name: "T1", description: "d1" }],
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when tasks array is empty", async () => {
      const res = await request(app).post("/api/task-groups").send({
        name: "Empty tasks",
        description: "Should fail",
        input: "input",
        tasks: [],
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when input exceeds max length", async () => {
      const res = await request(app).post("/api/task-groups").send({
        name: "Too long input",
        description: "Desc",
        input: "x".repeat(50001),
        tasks: [{ name: "T", description: "d" }],
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/task-groups/:id/start ─────────────────────────────────────

  describe("POST /api/task-groups/:id/start", () => {
    it("returns 200 with updated group when orchestrator succeeds", async () => {
      const group = await storage.createTaskGroup({
        name: "Startable Group",
        description: "For start test",
        input: "start input",
        createdBy: TEST_ADMIN.id,
      });

      const res = await request(app).post(`/api/task-groups/${group.id}/start`);
      expect(res.status).toBe(200);
      expect(orchestrator.startGroup).toHaveBeenCalledWith(group.id);
    });

    it("returns 400 when orchestrator throws (e.g. already running)", async () => {
      orchestrator.startGroup.mockRejectedValueOnce(new Error("Group is already running"));

      const group = await storage.createTaskGroup({
        name: "Already Running",
        description: "desc",
        input: "input",
        createdBy: TEST_ADMIN.id,
      });

      const res = await request(app).post(`/api/task-groups/${group.id}/start`);
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain("already running");
    });
  });

  // ─── POST /api/task-groups/:id/cancel ────────────────────────────────────

  describe("POST /api/task-groups/:id/cancel", () => {
    it("returns 200 with the group after cancellation", async () => {
      const group = await storage.createTaskGroup({
        name: "Cancellable Group",
        description: "For cancel test",
        input: "cancel input",
        createdBy: TEST_ADMIN.id,
      });
      await storage.updateTaskGroup(group.id, { status: "running" });

      const res = await request(app).post(`/api/task-groups/${group.id}/cancel`);
      expect(res.status).toBe(200);
      expect(orchestrator.cancelGroup).toHaveBeenCalledWith(group.id);
    });
  });

  // ─── DELETE /api/task-groups/:id ─────────────────────────────────────────

  describe("DELETE /api/task-groups/:id", () => {
    it("returns 204 on successful deletion", async () => {
      const group = await storage.createTaskGroup({
        name: "Delete Me",
        description: "For delete test",
        input: "delete input",
        createdBy: TEST_ADMIN.id,
      });

      const res = await request(app).delete(`/api/task-groups/${group.id}`);
      expect(res.status).toBe(204);

      // Confirm gone
      const getRes = await request(app).get(`/api/task-groups/${group.id}`);
      expect(getRes.status).toBe(404);
    });
  });

  // ─── POST /api/task-groups/:id/tasks/:taskId/retry ───────────────────────

  describe("POST /api/task-groups/:id/tasks/:taskId/retry", () => {
    it("returns 200 and retries the task", async () => {
      const group = await storage.createTaskGroup({
        name: "Retry Group",
        description: "For retry test",
        input: "retry input",
        createdBy: TEST_ADMIN.id,
      });
      const task = await storage.createTask({
        groupId: group.id,
        name: "Failed task",
        description: "was failing",
        sortOrder: 0,
      });
      await storage.updateTask(task.id, { status: "failed" });

      const res = await request(app).post(`/api/task-groups/${group.id}/tasks/${task.id}/retry`);
      expect(res.status).toBe(200);
      expect(orchestrator.retryTask).toHaveBeenCalledWith(task.id);
    });

    it("returns 400 when orchestrator throws on retry", async () => {
      orchestrator.retryTask.mockRejectedValueOnce(new Error("Task not in failed state"));

      const group = await storage.createTaskGroup({
        name: "Retry Fail Group",
        description: "For retry fail test",
        input: "input",
        createdBy: TEST_ADMIN.id,
      });
      const task = await storage.createTask({
        groupId: group.id,
        name: "Pending task",
        description: "pending",
        sortOrder: 0,
      });

      const res = await request(app).post(`/api/task-groups/${group.id}/tasks/${task.id}/retry`);
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toContain("not in failed state");
    });
  });

  // ─── GET /api/task-groups/:id/trace ──────────────────────────────────────

  describe("GET /api/task-groups/:id/trace (PR #169 — task trace waterfall)", () => {
    it("returns 404 when no trace exists for the group", async () => {
      const group = await storage.createTaskGroup({
        name: "No Trace Group",
        description: "No trace here",
        input: "input",
        createdBy: TEST_ADMIN.id,
      });

      const res = await request(app).get(`/api/task-groups/${group.id}/trace`);
      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toBeTruthy();
    });

    it("returns 200 with trace when one exists", async () => {
      const group = await storage.createTaskGroup({
        name: "With Trace Group",
        description: "Has trace",
        input: "input",
        createdBy: TEST_ADMIN.id,
      });
      // Seed a trace directly in storage
      await storage.createTaskTrace({
        groupId: group.id,
        spans: [],
      });

      const res = await request(app).get(`/api/task-groups/${group.id}/trace`);
      expect(res.status).toBe(200);
      const body = res.body as TaskTraceRow;
      expect(body.groupId).toBe(group.id);
      expect(Array.isArray(body.spans)).toBe(true);
    });

    it("returns 400 when group id is empty string path", async () => {
      // Express will not route an empty segment — test with a special sentinel
      const res = await request(app).get("/api/task-groups//trace");
      // Express returns 404 for unmatched path patterns
      expect([400, 404]).toContain(res.status);
    });
  });
});
