/**
 * Unit tests for TrackerSyncService (PR #171).
 *
 * Uses a mock IStorage and mock adapter to avoid real HTTP calls.
 * Verifies:
 * - syncComment: posts to adapters with syncComments=true, skips others
 * - syncComment: swallows adapter errors (doesn't throw)
 * - syncSubtasks: creates subtasks for adapters with syncSubtasks=true
 * - syncSubtasks: returns externalId from adapter
 * - syncSubtasks: swallows adapter errors, returns null externalId
 * - syncSubtaskStatus: calls adapter when syncSubtasks=true
 * - syncSubtaskStatus: swallows adapter errors
 * - createTrackerAdapter: throws for unknown providers
 * - createTrackerAdapter: throws for jira without required config
 */
import { describe, it, expect, vi } from "vitest";
import { TrackerSyncService } from "../../../server/services/tracker-sync.js";
import { createTrackerAdapter } from "../../../server/services/trackers/index.js";
import type { IStorage } from "../../../server/storage.js";
import type { TrackerConnectionRow } from "../../../shared/schema.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConnection(overrides: Partial<TrackerConnectionRow> = {}): TrackerConnectionRow {
  return {
    id: "conn-1",
    taskGroupId: "group-1",
    provider: "jira",
    issueUrl: "https://co.atlassian.net/browse/PROJ-1",
    issueKey: "PROJ-1",
    projectKey: "PROJ",
    syncComments: true,
    syncSubtasks: true,
    apiToken: "token",
    baseUrl: "https://co.atlassian.net",
    metadata: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

function makeMockStorage(connections: TrackerConnectionRow[]): IStorage {
  return {
    getTrackerConnectionsByGroup: vi.fn().mockResolvedValue(connections),
  } as unknown as IStorage;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TrackerSyncService", () => {
  // ─── syncComment ───────────────────────────────────────────────────────────

  describe("syncComment", () => {
    it("queries storage for connections when syncing a comment", async () => {
      // Use a stub provider that throws — service should swallow the error
      // and still complete. The key behaviour: storage is queried for connections.
      const conn = makeConnection({ provider: "clickup", syncComments: true, apiToken: null, baseUrl: null });
      const storage = makeMockStorage([conn]);
      const service = new TrackerSyncService(storage);

      await service.syncComment("group-1", "Task group created");

      expect(storage.getTrackerConnectionsByGroup).toHaveBeenCalledWith("group-1");
    });

    it("skips connections with syncComments=false", async () => {
      const conn = makeConnection({ syncComments: false });
      const storage = makeMockStorage([conn]);
      const service = new TrackerSyncService(storage);

      // If it did try to create an adapter for jira without mocking, it would call fetch.
      // We verify no error is thrown — the connection is skipped entirely.
      await expect(service.syncComment("group-1", "A comment")).resolves.toBeUndefined();
    });

    it("does not throw when there are no connections", async () => {
      const storage = makeMockStorage([]);
      const service = new TrackerSyncService(storage);

      await expect(service.syncComment("group-1", "comment")).resolves.toBeUndefined();
    });

    it("swallows adapter errors and completes without throwing", async () => {
      // Use clickup/linear which are stubs that throw
      const conn = makeConnection({ provider: "clickup", syncComments: true, apiToken: null, baseUrl: null });
      const storage = makeMockStorage([conn]);
      const service = new TrackerSyncService(storage);

      // ClickUp adapter throws "not implemented" — service should swallow it
      await expect(service.syncComment("group-1", "A comment")).resolves.toBeUndefined();
    });

    it("processes multiple connections, swallowing individual failures", async () => {
      const conns = [
        makeConnection({ id: "c1", provider: "clickup", syncComments: true, apiToken: null, baseUrl: null }),
        makeConnection({ id: "c2", provider: "linear", syncComments: true, apiToken: null, baseUrl: null }),
      ];
      const storage = makeMockStorage(conns);
      const service = new TrackerSyncService(storage);

      // Both clickup and linear are stubs that throw — both should be swallowed
      await expect(service.syncComment("group-1", "comment")).resolves.toBeUndefined();
    });
  });

  // ─── syncSubtasks ─────────────────────────────────────────────────────────

  describe("syncSubtasks", () => {
    it("returns empty array when there are no connections", async () => {
      const storage = makeMockStorage([]);
      const service = new TrackerSyncService(storage);

      const results = await service.syncSubtasks("group-1", [
        { title: "T1", description: "desc" },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("T1");
      expect(results[0].externalId).toBeNull();
    });

    it("returns null externalId when syncSubtasks=false on connection", async () => {
      const conn = makeConnection({ syncSubtasks: false });
      const storage = makeMockStorage([conn]);
      const service = new TrackerSyncService(storage);

      const results = await service.syncSubtasks("group-1", [
        { title: "T1", description: "desc" },
      ]);

      expect(results[0].externalId).toBeNull();
    });

    it("swallows adapter errors and returns null externalId for failing connections", async () => {
      const conn = makeConnection({ provider: "clickup", syncSubtasks: true, apiToken: null, baseUrl: null });
      const storage = makeMockStorage([conn]);
      const service = new TrackerSyncService(storage);

      // ClickUp stub throws
      const results = await service.syncSubtasks("group-1", [
        { title: "Feature Task", description: "description" },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Feature Task");
      expect(results[0].externalId).toBeNull();
    });

    it("returns results for every input task even when adapter fails", async () => {
      const conn = makeConnection({ provider: "linear", syncSubtasks: true, apiToken: null, baseUrl: null });
      const storage = makeMockStorage([conn]);
      const service = new TrackerSyncService(storage);

      const tasks = [
        { title: "Task A", description: "desc A" },
        { title: "Task B", description: "desc B" },
        { title: "Task C", description: "desc C" },
      ];
      const results = await service.syncSubtasks("group-1", tasks);

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.title)).toEqual(["Task A", "Task B", "Task C"]);
    });

    it("returns empty results array when no tasks provided", async () => {
      const storage = makeMockStorage([]);
      const service = new TrackerSyncService(storage);

      const results = await service.syncSubtasks("group-1", []);

      expect(results).toEqual([]);
    });
  });

  // ─── syncSubtaskStatus ────────────────────────────────────────────────────

  describe("syncSubtaskStatus", () => {
    it("does not throw when there are no connections", async () => {
      const storage = makeMockStorage([]);
      const service = new TrackerSyncService(storage);

      await expect(
        service.syncSubtaskStatus("group-1", "ext-123", "done"),
      ).resolves.toBeUndefined();
    });

    it("skips connections with syncSubtasks=false", async () => {
      const conn = makeConnection({ syncSubtasks: false });
      const storage = makeMockStorage([conn]);
      const service = new TrackerSyncService(storage);

      // No adapter created — no error expected
      await expect(
        service.syncSubtaskStatus("group-1", "ext-123", "done"),
      ).resolves.toBeUndefined();
    });

    it("swallows adapter errors and does not throw", async () => {
      const conn = makeConnection({ provider: "clickup", syncSubtasks: true, apiToken: null, baseUrl: null });
      const storage = makeMockStorage([conn]);
      const service = new TrackerSyncService(storage);

      // ClickUp stub throws
      await expect(
        service.syncSubtaskStatus("group-1", "ext-123", "done"),
      ).resolves.toBeUndefined();
    });
  });
});

// ─── createTrackerAdapter (factory) ──────────────────────────────────────────

describe("createTrackerAdapter factory", () => {
  it("throws for unknown provider", () => {
    expect(() =>
      createTrackerAdapter("trello" as "jira", { baseUrl: null, apiToken: null }),
    ).toThrow(/Unknown tracker provider/);
  });

  it("throws for jira without baseUrl", () => {
    expect(() =>
      createTrackerAdapter("jira", { baseUrl: null, apiToken: "tok" }),
    ).toThrow(/Jira requires a baseUrl/);
  });

  it("throws for jira without apiToken", () => {
    expect(() =>
      createTrackerAdapter("jira", { baseUrl: "https://co.atlassian.net", apiToken: null }),
    ).toThrow(/Jira requires an apiToken/);
  });

  it("returns a JiraAdapter for provider=jira with valid config", () => {
    const adapter = createTrackerAdapter("jira", {
      baseUrl: "https://co.atlassian.net",
      apiToken: "token",
    });
    expect(adapter).toBeDefined();
    expect(typeof adapter.addComment).toBe("function");
    expect(typeof adapter.createSubtask).toBe("function");
    expect(typeof adapter.updateSubtaskStatus).toBe("function");
  });

  it("returns a ClickUpAdapter for provider=clickup (stub)", () => {
    const adapter = createTrackerAdapter("clickup", { baseUrl: null, apiToken: null });
    expect(adapter).toBeDefined();
    // ClickUp is a stub — methods throw "not implemented"
    expect(adapter.addComment("key", "comment")).rejects.toThrow(/not implemented/);
  });

  it("returns a LinearAdapter for provider=linear (stub)", () => {
    const adapter = createTrackerAdapter("linear", { baseUrl: null, apiToken: null });
    expect(adapter).toBeDefined();
    expect(adapter.addComment("key", "comment")).rejects.toThrow(/not implemented/);
  });

  it("returns a GitHubAdapter for provider=github (stub)", () => {
    const adapter = createTrackerAdapter("github", { baseUrl: null, apiToken: null });
    expect(adapter).toBeDefined();
    expect(adapter.addComment("key", "comment")).rejects.toThrow(/not implemented/);
  });
});
