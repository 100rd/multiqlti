/**
 * Integration tests for Tracker Connections API (PR #171).
 *
 * Uses MemStorage + mock TaskSplitter + mock TrackerSyncService + mock TaskOrchestrator.
 * Verifies:
 * - POST /api/tracker-connections          — create connection (valid + invalid)
 * - GET  /api/tracker-connections/:groupId — list connections for a group
 * - DELETE /api/tracker-connections/:id    — delete connection
 * - POST /api/task-groups/split-preview    — LLM split preview
 * - POST /api/task-groups/submit-work      — full flow: split + create + optional tracker
 *
 * Auth: all routes are protected (app.use requireAuth in routes.ts); here we inject
 * a synthetic user the same way other integration tests do.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import type { Express, Router } from "express";
import { MemStorage } from "../../server/storage.js";
import { registerTrackerRoutes } from "../../server/routes/tracker.js";
import { registerTaskGroupRoutes } from "../../server/routes/task-groups.js";
import type { User, SplitTask } from "../../shared/types.js";
import type { TrackerConnectionRow, TaskGroupRow, TaskRow } from "../../shared/schema.js";

// ─── Synthetic user ───────────────────────────────────────────────────────────

const TEST_USER: User = {
  id: "tracker-test-user",
  email: "tracker@test.com",
  name: "Tracker Tester",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeMockTaskSplitter() {
  return {
    split: vi.fn(async (_storyText: string, _modelSlug: string): Promise<SplitTask[]> => [
      {
        name: "Backend API",
        description: "Build REST endpoints",
        conditionsOfDone: ["All endpoints tested"],
        tests: ["POST /api/items returns 201"],
        dependsOn: undefined,
      },
      {
        name: "Frontend UI",
        description: "Build React components",
        conditionsOfDone: ["Components render correctly"],
        tests: ["Renders without error"],
        dependsOn: ["Backend API"],
      },
    ]),
  };
}

function makeMockTrackerSync() {
  return {
    syncComment: vi.fn(async (_groupId: string, _comment: string): Promise<void> => {}),
    syncSubtasks: vi.fn(async (_groupId: string, _tasks: Array<{ title: string; description: string }>) => []),
    syncSubtaskStatus: vi.fn(async (_groupId: string, _externalId: string, _status: string): Promise<void> => {}),
  };
}

function makeMockOrchestrator(storage: MemStorage) {
  return {
    createTaskGroup: vi.fn(async (data: { name: string; description: string; input: string; createdBy?: string; tasks: Array<{ name: string; description: string }> }) => {
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
    }),
    startGroup: vi.fn(),
    cancelGroup: vi.fn(),
    retryTask: vi.fn(),
  };
}

// ─── App factory ─────────────────────────────────────────────────────────────

async function createTestApp() {
  const storage = new MemStorage();
  const taskSplitter = makeMockTaskSplitter();
  const trackerSync = makeMockTrackerSync();
  const orchestrator = makeMockOrchestrator(storage);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = TEST_USER;
    next();
  });

  registerTaskGroupRoutes(app as unknown as Router, storage, orchestrator as unknown as import("../../server/services/task-orchestrator.js").TaskOrchestrator);
  registerTrackerRoutes(
    app as unknown as Router,
    storage,
    taskSplitter as unknown as import("../../server/services/task-splitter.js").TaskSplitter,
    trackerSync as unknown as import("../../server/services/tracker-sync.js").TrackerSyncService,
    orchestrator as unknown as import("../../server/services/task-orchestrator.js").TaskOrchestrator,
  );

  const httpServer = createServer(app);
  return {
    app,
    storage,
    taskSplitter,
    trackerSync,
    orchestrator,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Tracker Connections API", () => {
  let app: Express;
  let storage: MemStorage;
  let taskSplitter: ReturnType<typeof makeMockTaskSplitter>;
  let trackerSync: ReturnType<typeof makeMockTrackerSync>;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    storage = ctx.storage;
    taskSplitter = ctx.taskSplitter;
    trackerSync = ctx.trackerSync;
    closeApp = ctx.close;
  }, 15_000);

  afterAll(async () => {
    await closeApp();
  });

  // ─── POST /api/tracker-connections ───────────────────────────────────────

  describe("POST /api/tracker-connections", () => {
    it("returns 201 with created connection on valid jira payload", async () => {
      // Create a task group to link to
      const group = await storage.createTaskGroup({
        name: "Jira Group",
        description: "For jira test",
        input: "input",
        createdBy: TEST_USER.id,
      });

      const payload = {
        taskGroupId: group.id,
        provider: "jira",
        issueUrl: "https://company.atlassian.net/browse/PROJ-1",
        issueKey: "PROJ-1",
        projectKey: "PROJ",
        apiToken: "base64token",
        baseUrl: "https://company.atlassian.net",
        syncComments: true,
        syncSubtasks: false,
      };

      const res = await request(app).post("/api/tracker-connections").send(payload);
      expect(res.status).toBe(201);
      const body = res.body as TrackerConnectionRow;
      expect(body.provider).toBe("jira");
      expect(body.issueKey).toBe("PROJ-1");
      expect(body.taskGroupId).toBe(group.id);
      expect(body.id).toBeTruthy();
    });

    it("returns 201 for clickup provider without optional fields", async () => {
      const group = await storage.createTaskGroup({
        name: "ClickUp Group",
        description: "For clickup test",
        input: "input",
        createdBy: TEST_USER.id,
      });

      const res = await request(app).post("/api/tracker-connections").send({
        taskGroupId: group.id,
        provider: "clickup",
        issueUrl: "https://app.clickup.com/t/TASK-123",
        issueKey: "TASK-123",
      });
      expect(res.status).toBe(201);
      const body = res.body as TrackerConnectionRow;
      expect(body.provider).toBe("clickup");
    });

    it("returns 400 when provider is not recognized", async () => {
      const group = await storage.createTaskGroup({
        name: "Bad Provider Group",
        description: "desc",
        input: "input",
        createdBy: TEST_USER.id,
      });

      const res = await request(app).post("/api/tracker-connections").send({
        taskGroupId: group.id,
        provider: "trello", // not in TRACKER_PROVIDERS
        issueUrl: "https://trello.com/c/abc123",
        issueKey: "abc123",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when issueUrl is not a valid URL", async () => {
      const group = await storage.createTaskGroup({
        name: "Bad URL Group",
        description: "desc",
        input: "input",
        createdBy: TEST_USER.id,
      });

      const res = await request(app).post("/api/tracker-connections").send({
        taskGroupId: group.id,
        provider: "linear",
        issueUrl: "not-a-url",
        issueKey: "LIN-1",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when taskGroupId is missing", async () => {
      const res = await request(app).post("/api/tracker-connections").send({
        provider: "github",
        issueUrl: "https://github.com/org/repo/issues/1",
        issueKey: "1",
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/tracker-connections/:groupId ────────────────────────────────

  describe("GET /api/tracker-connections/:groupId", () => {
    it("returns 200 with empty array for group with no connections", async () => {
      const group = await storage.createTaskGroup({
        name: "No Connections",
        description: "desc",
        input: "input",
        createdBy: TEST_USER.id,
      });

      const res = await request(app).get(`/api/tracker-connections/${group.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns connections for the specified group only", async () => {
      const groupA = await storage.createTaskGroup({
        name: "Group A",
        description: "desc",
        input: "input",
        createdBy: TEST_USER.id,
      });
      const groupB = await storage.createTaskGroup({
        name: "Group B",
        description: "desc",
        input: "input",
        createdBy: TEST_USER.id,
      });

      // Create connections for both groups
      await storage.createTrackerConnection({
        taskGroupId: groupA.id,
        provider: "jira",
        issueUrl: "https://co.atlassian.net/browse/A-1",
        issueKey: "A-1",
      });
      await storage.createTrackerConnection({
        taskGroupId: groupB.id,
        provider: "linear",
        issueUrl: "https://linear.app/team/issue/B-1",
        issueKey: "B-1",
      });

      const resA = await request(app).get(`/api/tracker-connections/${groupA.id}`);
      expect(resA.status).toBe(200);
      const connectionsA = resA.body as TrackerConnectionRow[];
      expect(connectionsA.every((c) => c.taskGroupId === groupA.id)).toBe(true);
      expect(connectionsA.every((c) => c.taskGroupId !== groupB.id)).toBe(true);
    });
  });

  // ─── DELETE /api/tracker-connections/:id ─────────────────────────────────

  describe("DELETE /api/tracker-connections/:id", () => {
    it("returns 204 on successful deletion", async () => {
      const group = await storage.createTaskGroup({
        name: "Delete Connection Group",
        description: "desc",
        input: "input",
        createdBy: TEST_USER.id,
      });
      const conn = await storage.createTrackerConnection({
        taskGroupId: group.id,
        provider: "github",
        issueUrl: "https://github.com/org/repo/issues/42",
        issueKey: "42",
      });

      const res = await request(app).delete(`/api/tracker-connections/${conn.id}`);
      expect(res.status).toBe(204);

      // Confirm it's gone
      const listRes = await request(app).get(`/api/tracker-connections/${group.id}`);
      const conns = listRes.body as TrackerConnectionRow[];
      expect(conns.find((c) => c.id === conn.id)).toBeUndefined();
    });
  });

  // ─── POST /api/task-groups/split-preview ─────────────────────────────────

  describe("POST /api/task-groups/split-preview", () => {
    it("returns 200 with tasks array from LLM split", async () => {
      const res = await request(app).post("/api/task-groups/split-preview").send({
        storyText: "As a user I want to log in so that I can access my dashboard",
        modelSlug: "claude-haiku-4-5",
      });

      expect(res.status).toBe(200);
      const body = res.body as { tasks: SplitTask[] };
      expect(Array.isArray(body.tasks)).toBe(true);
      expect(body.tasks.length).toBeGreaterThan(0);
      expect(taskSplitter.split).toHaveBeenCalledOnce();
    });

    it("returns 400 when storyText is missing", async () => {
      const res = await request(app).post("/api/task-groups/split-preview").send({
        modelSlug: "claude-haiku-4-5",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when modelSlug is missing", async () => {
      const res = await request(app).post("/api/task-groups/split-preview").send({
        storyText: "Some feature",
      });
      expect(res.status).toBe(400);
    });

    it("returns 500 when TaskSplitter throws", async () => {
      taskSplitter.split.mockRejectedValueOnce(new Error("LLM timeout"));

      const res = await request(app).post("/api/task-groups/split-preview").send({
        storyText: "A feature description",
        modelSlug: "claude-haiku-4-5",
      });
      expect(res.status).toBe(500);
      expect((res.body as { error: string }).error).toContain("LLM timeout");
    });
  });

  // ─── POST /api/task-groups/submit-work ───────────────────────────────────

  describe("POST /api/task-groups/submit-work", () => {
    it("returns 201 with group + tasks on minimal payload (no tracker)", async () => {
      taskSplitter.split.mockClear();

      const res = await request(app).post("/api/task-groups/submit-work").send({
        name: "Auth Feature",
        description: "User authentication flow",
        storyText: "As a user I want to log in with email and password",
        modelSlug: "claude-haiku-4-5",
      });

      expect(res.status).toBe(201);
      const body = res.body as { group: TaskGroupRow; tasks: TaskRow[]; trackerConnection: null };
      expect(body.group.name).toBe("Auth Feature");
      expect(Array.isArray(body.tasks)).toBe(true);
      expect(body.trackerConnection).toBeNull();
      expect(taskSplitter.split).toHaveBeenCalledOnce();
    });

    it("returns 201 and creates tracker connection when trackerUrl is provided", async () => {
      taskSplitter.split.mockClear();
      trackerSync.syncComment.mockClear();

      const res = await request(app).post("/api/task-groups/submit-work").send({
        name: "Tracked Feature",
        description: "Feature with tracker",
        storyText: "As a user I want to view my profile",
        modelSlug: "claude-haiku-4-5",
        trackerUrl: "https://company.atlassian.net/browse/PROJ-5",
        trackerProvider: "jira",
        trackerIssueKey: "PROJ-5",
        trackerApiToken: "mytoken",
        trackerBaseUrl: "https://company.atlassian.net",
      });

      expect(res.status).toBe(201);
      const body = res.body as { group: TaskGroupRow; tasks: TaskRow[]; trackerConnection: TrackerConnectionRow };
      expect(body.group).toBeDefined();
      expect(body.trackerConnection).toBeDefined();
      expect(body.trackerConnection.provider).toBe("jira");
      expect(body.trackerConnection.issueKey).toBe("PROJ-5");
    });

    it("returns 400 when storyText is missing", async () => {
      const res = await request(app).post("/api/task-groups/submit-work").send({
        name: "No Story",
        description: "desc",
        modelSlug: "claude-haiku-4-5",
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(app).post("/api/task-groups/submit-work").send({
        description: "desc",
        storyText: "story",
        modelSlug: "claude-haiku-4-5",
      });
      expect(res.status).toBe(400);
    });
  });
});
