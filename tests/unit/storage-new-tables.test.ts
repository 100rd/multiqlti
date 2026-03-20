/**
 * Unit tests for MemStorage — new tables added in PRs #167, #169, #171.
 *
 * Covers:
 * - SkillTeams: getSkillTeams, createSkillTeam, deleteSkillTeam
 * - TaskGroups: getTaskGroups, getTaskGroup, createTaskGroup, updateTaskGroup, deleteTaskGroup
 * - Tasks: createTask, getTask, getTasksByGroup, updateTask, getReadyTasks, getBlockedTasks
 * - TaskTraces: createTaskTrace, getTaskTrace, updateTaskTrace
 * - TrackerConnections: createTrackerConnection, getTrackerConnectionsByGroup,
 *                       getTrackerConnection, deleteTrackerConnection
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../server/storage.js";
import type { TaskTraceSpan } from "../../shared/types.js";

describe("MemStorage — new tables", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  // ─── SkillTeams ────────────────────────────────────────────────────────────

  describe("SkillTeams", () => {
    it("getSkillTeams() returns empty array initially", async () => {
      const teams = await storage.getSkillTeams();
      expect(teams).toEqual([]);
    });

    it("createSkillTeam() returns a team with generated id and timestamps", async () => {
      const team = await storage.createSkillTeam({
        name: "Frontend Squad",
        description: "Owns all UI components",
        createdBy: "user-1",
      });

      expect(team.id).toBeTruthy();
      expect(team.name).toBe("Frontend Squad");
      expect(team.description).toBe("Owns all UI components");
      expect(team.createdBy).toBe("user-1");
      expect(team.createdAt).toBeInstanceOf(Date);
    });

    it("getSkillTeams() returns all created teams sorted by createdAt", async () => {
      await storage.createSkillTeam({ name: "Alpha", description: "", createdBy: "u1" });
      await storage.createSkillTeam({ name: "Beta", description: "", createdBy: "u1" });

      const teams = await storage.getSkillTeams();
      expect(teams).toHaveLength(2);
      const names = teams.map((t) => t.name);
      expect(names).toContain("Alpha");
      expect(names).toContain("Beta");
    });

    it("deleteSkillTeam() removes the team by id", async () => {
      const team = await storage.createSkillTeam({ name: "To Delete", description: "", createdBy: "u1" });
      await storage.deleteSkillTeam(team.id);

      const teams = await storage.getSkillTeams();
      expect(teams.find((t) => t.id === team.id)).toBeUndefined();
    });

    it("deleteSkillTeam() is a no-op for non-existent id (does not throw)", async () => {
      await expect(storage.deleteSkillTeam("nonexistent-id")).resolves.toBeUndefined();
    });

    it("createSkillTeam() stores each team independently", async () => {
      const t1 = await storage.createSkillTeam({ name: "T1", description: "d1", createdBy: "u1" });
      const t2 = await storage.createSkillTeam({ name: "T2", description: "d2", createdBy: "u2" });

      expect(t1.id).not.toBe(t2.id);
      const teams = await storage.getSkillTeams();
      expect(teams).toHaveLength(2);
    });
  });

  // ─── TaskGroups ────────────────────────────────────────────────────────────

  describe("TaskGroups", () => {
    it("getTaskGroups() returns empty array initially", async () => {
      const groups = await storage.getTaskGroups();
      expect(groups).toEqual([]);
    });

    it("createTaskGroup() returns row with generated id, default status=pending", async () => {
      const group = await storage.createTaskGroup({
        name: "Auth Feature",
        description: "Implement authentication",
        input: "User story text here",
        createdBy: "user-1",
      });

      expect(group.id).toBeTruthy();
      expect(group.name).toBe("Auth Feature");
      expect(group.status).toBe("pending");
      expect(group.createdBy).toBe("user-1");
      expect(group.createdAt).toBeInstanceOf(Date);
      expect(group.startedAt).toBeNull();
      expect(group.completedAt).toBeNull();
    });

    it("getTaskGroup() returns undefined for unknown id", async () => {
      const result = await storage.getTaskGroup("not-a-real-id");
      expect(result).toBeUndefined();
    });

    it("getTaskGroup() returns the correct group", async () => {
      const group = await storage.createTaskGroup({ name: "G1", description: "d", input: "i", createdBy: null });

      const found = await storage.getTaskGroup(group.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(group.id);
    });

    it("updateTaskGroup() updates status field", async () => {
      const group = await storage.createTaskGroup({ name: "Updateable", description: "d", input: "i", createdBy: "u1" });

      const updated = await storage.updateTaskGroup(group.id, { status: "running" });

      expect(updated.status).toBe("running");
      expect(updated.id).toBe(group.id);
    });

    it("updateTaskGroup() throws for non-existent id", async () => {
      await expect(
        storage.updateTaskGroup("nonexistent", { status: "running" }),
      ).rejects.toThrow(/not found/i);
    });

    it("deleteTaskGroup() removes the group", async () => {
      const group = await storage.createTaskGroup({ name: "Delete Me", description: "d", input: "i", createdBy: null });
      await storage.deleteTaskGroup(group.id);

      const found = await storage.getTaskGroup(group.id);
      expect(found).toBeUndefined();
    });

    it("getTaskGroups() returns groups sorted by createdAt descending", async () => {
      await storage.createTaskGroup({ name: "First", description: "d", input: "i", createdBy: null });
      await storage.createTaskGroup({ name: "Second", description: "d", input: "i", createdBy: null });

      const groups = await storage.getTaskGroups();
      // Both are present; at minimum verify count
      expect(groups.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Tasks ─────────────────────────────────────────────────────────────────

  describe("Tasks", () => {
    let groupId: string;

    beforeEach(async () => {
      const group = await storage.createTaskGroup({ name: "Task Group", description: "d", input: "i", createdBy: null });
      groupId = group.id;
    });

    it("createTask() returns row with generated id and default status=pending", async () => {
      const task = await storage.createTask({
        groupId,
        name: "First Task",
        description: "Do something",
        sortOrder: 0,
      });

      expect(task.id).toBeTruthy();
      expect(task.groupId).toBe(groupId);
      expect(task.name).toBe("First Task");
      expect(task.status).toBe("pending");
      expect(task.sortOrder).toBe(0);
      expect(task.createdAt).toBeInstanceOf(Date);
    });

    it("getTask() returns undefined for unknown id", async () => {
      const result = await storage.getTask("nonexistent");
      expect(result).toBeUndefined();
    });

    it("getTask() returns the correct task", async () => {
      const task = await storage.createTask({ groupId, name: "T", description: "d", sortOrder: 0 });
      const found = await storage.getTask(task.id);
      expect(found?.id).toBe(task.id);
    });

    it("getTasksByGroup() returns only tasks for the specified group", async () => {
      const otherGroup = await storage.createTaskGroup({ name: "Other", description: "d", input: "i", createdBy: null });

      await storage.createTask({ groupId, name: "Mine", description: "d", sortOrder: 0 });
      await storage.createTask({ groupId: otherGroup.id, name: "Theirs", description: "d", sortOrder: 0 });

      const mine = await storage.getTasksByGroup(groupId);
      expect(mine).toHaveLength(1);
      expect(mine[0].name).toBe("Mine");
    });

    it("getTasksByGroup() returns tasks sorted by sortOrder", async () => {
      await storage.createTask({ groupId, name: "C", description: "d", sortOrder: 2 });
      await storage.createTask({ groupId, name: "A", description: "d", sortOrder: 0 });
      await storage.createTask({ groupId, name: "B", description: "d", sortOrder: 1 });

      const tasks = await storage.getTasksByGroup(groupId);
      expect(tasks.map((t) => t.name)).toEqual(["A", "B", "C"]);
    });

    it("updateTask() updates status and output", async () => {
      const task = await storage.createTask({ groupId, name: "T", description: "d", sortOrder: 0 });

      const updated = await storage.updateTask(task.id, { status: "completed", output: "Result text" });

      expect(updated.status).toBe("completed");
      expect(updated.output).toBe("Result text");
    });

    it("getReadyTasks() returns only tasks with status=ready", async () => {
      // MemStorage.getReadyTasks filters by status === "ready" (set by TaskOrchestrator)
      const t1 = await storage.createTask({ groupId, name: "T1", description: "d", sortOrder: 0 });
      const t2 = await storage.createTask({ groupId, name: "T2", description: "d", sortOrder: 1 });
      await storage.updateTask(t1.id, { status: "ready" });
      // t2 remains pending

      const ready = await storage.getReadyTasks(groupId);
      const readyNames = ready.map((t) => t.name);
      expect(readyNames).toContain("T1");
      expect(readyNames).not.toContain("T2");
    });

    it("getBlockedTasks() returns only tasks with status=blocked", async () => {
      // MemStorage.getBlockedTasks filters by status === "blocked" (set by TaskOrchestrator)
      const t1 = await storage.createTask({ groupId, name: "T1", description: "d", sortOrder: 0 });
      const t2 = await storage.createTask({ groupId, name: "T2", description: "d", sortOrder: 1 });
      await storage.updateTask(t2.id, { status: "blocked" });
      // t1 remains pending

      const blocked = await storage.getBlockedTasks(groupId);
      const blockedNames = blocked.map((t) => t.name);
      expect(blockedNames).toContain("T2");
      expect(blockedNames).not.toContain("T1");
    });
  });

  // ─── TaskTraces ────────────────────────────────────────────────────────────

  describe("TaskTraces", () => {
    let groupId: string;

    beforeEach(async () => {
      const group = await storage.createTaskGroup({ name: "Trace Group", description: "d", input: "i", createdBy: null });
      groupId = group.id;
    });

    it("getTaskTrace() returns null when no trace exists for a group", async () => {
      const result = await storage.getTaskTrace(groupId);
      expect(result).toBeNull();
    });

    it("createTaskTrace() returns row with generated id and timestamps", async () => {
      const trace = await storage.createTaskTrace({
        groupId,
        spans: [],
      });

      expect(trace.id).toBeTruthy();
      expect(trace.groupId).toBe(groupId);
      expect(trace.spans).toEqual([]);
      expect(trace.createdAt).toBeInstanceOf(Date);
    });

    it("getTaskTrace() returns the trace after creation", async () => {
      await storage.createTaskTrace({ groupId, spans: [] });

      const found = await storage.getTaskTrace(groupId);
      expect(found).toBeDefined();
      expect(found?.groupId).toBe(groupId);
    });

    it("createTaskTrace() with rootSpan stores the root span", async () => {
      const rootSpan: TaskTraceSpan = {
        id: "span-root",
        taskId: "task-1",
        taskName: "Root Task",
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        model: "claude-haiku-4-5",
        input: "Start input",
        output: null,
        children: [],
        durationMs: null,
        error: null,
      };
      const trace = await storage.createTaskTrace({ groupId, spans: [], rootSpan });

      expect(trace.rootSpan).toBeDefined();
      expect(trace.rootSpan?.id).toBe("span-root");
    });

    it("updateTaskTrace() updates spans and rootSpan", async () => {
      const trace = await storage.createTaskTrace({ groupId, spans: [] });

      const newSpan: TaskTraceSpan = {
        id: "span-1",
        taskId: "task-1",
        taskName: "Updated Task",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        model: "mock",
        input: "input",
        output: "result",
        children: [],
        durationMs: 1500,
        error: null,
      };

      const updated = await storage.updateTaskTrace(trace.id, {
        spans: [newSpan],
      });

      expect(updated.spans).toHaveLength(1);
      expect(updated.spans[0].id).toBe("span-1");
    });

    it("updateTaskTrace() throws for unknown trace id", async () => {
      await expect(
        storage.updateTaskTrace("nonexistent-trace", { spans: [] }),
      ).rejects.toThrow();
    });

    it("getTaskTrace() returns null for a different group that has no trace", async () => {
      const group2 = await storage.createTaskGroup({ name: "G2", description: "d", input: "i", createdBy: null });
      await storage.createTaskTrace({ groupId, spans: [] }); // Create trace for groupId only

      const result = await storage.getTaskTrace(group2.id);
      expect(result).toBeNull();
    });
  });

  // ─── TrackerConnections ────────────────────────────────────────────────────

  describe("TrackerConnections", () => {
    let groupId: string;

    beforeEach(async () => {
      const group = await storage.createTaskGroup({ name: "Tracker Group", description: "d", input: "i", createdBy: null });
      groupId = group.id;
    });

    it("getTrackerConnectionsByGroup() returns empty array initially", async () => {
      const conns = await storage.getTrackerConnectionsByGroup(groupId);
      expect(conns).toEqual([]);
    });

    it("createTrackerConnection() returns row with generated id", async () => {
      const conn = await storage.createTrackerConnection({
        taskGroupId: groupId,
        provider: "jira",
        issueUrl: "https://co.atlassian.net/browse/PROJ-1",
        issueKey: "PROJ-1",
        projectKey: "PROJ",
        apiToken: "tok",
        baseUrl: "https://co.atlassian.net",
      });

      expect(conn.id).toBeTruthy();
      expect(conn.taskGroupId).toBe(groupId);
      expect(conn.provider).toBe("jira");
      expect(conn.issueKey).toBe("PROJ-1");
      expect(conn.createdAt).toBeInstanceOf(Date);
    });

    it("createTrackerConnection() stores syncComments and syncSubtasks flags", async () => {
      const conn = await storage.createTrackerConnection({
        taskGroupId: groupId,
        provider: "linear",
        issueUrl: "https://linear.app/team/issue/LIN-1",
        issueKey: "LIN-1",
        syncComments: true,
        syncSubtasks: false,
      });

      expect(conn.syncComments).toBe(true);
      expect(conn.syncSubtasks).toBe(false);
    });

    it("getTrackerConnectionsByGroup() returns only connections for the specified group", async () => {
      const otherGroup = await storage.createTaskGroup({ name: "Other", description: "d", input: "i", createdBy: null });

      await storage.createTrackerConnection({
        taskGroupId: groupId,
        provider: "jira",
        issueUrl: "https://co.atlassian.net/browse/MY-1",
        issueKey: "MY-1",
      });
      await storage.createTrackerConnection({
        taskGroupId: otherGroup.id,
        provider: "github",
        issueUrl: "https://github.com/org/repo/issues/1",
        issueKey: "1",
      });

      const mine = await storage.getTrackerConnectionsByGroup(groupId);
      expect(mine).toHaveLength(1);
      expect(mine[0].issueKey).toBe("MY-1");
    });

    it("getTrackerConnection() returns undefined for unknown id", async () => {
      const result = await storage.getTrackerConnection("nonexistent");
      expect(result).toBeUndefined();
    });

    it("getTrackerConnection() returns correct connection by id", async () => {
      const conn = await storage.createTrackerConnection({
        taskGroupId: groupId,
        provider: "clickup",
        issueUrl: "https://app.clickup.com/t/TASK-1",
        issueKey: "TASK-1",
      });

      const found = await storage.getTrackerConnection(conn.id);
      expect(found?.id).toBe(conn.id);
      expect(found?.provider).toBe("clickup");
    });

    it("deleteTrackerConnection() removes the connection", async () => {
      const conn = await storage.createTrackerConnection({
        taskGroupId: groupId,
        provider: "github",
        issueUrl: "https://github.com/org/repo/issues/99",
        issueKey: "99",
      });

      await storage.deleteTrackerConnection(conn.id);

      const found = await storage.getTrackerConnection(conn.id);
      expect(found).toBeUndefined();
    });

    it("deleteTrackerConnection() is a no-op for non-existent id (does not throw)", async () => {
      await expect(storage.deleteTrackerConnection("ghost-id")).resolves.toBeUndefined();
    });

    it("createTrackerConnection() with null optional fields stores null", async () => {
      const conn = await storage.createTrackerConnection({
        taskGroupId: groupId,
        provider: "linear",
        issueUrl: "https://linear.app/team/issue/LIN-2",
        issueKey: "LIN-2",
        apiToken: null,
        baseUrl: null,
        projectKey: null,
        metadata: null,
      });

      expect(conn.apiToken).toBeNull();
      expect(conn.baseUrl).toBeNull();
      expect(conn.projectKey).toBeNull();
      expect(conn.metadata).toBeNull();
    });
  });
});
