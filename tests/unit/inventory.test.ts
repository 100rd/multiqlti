/**
 * Tests for inventory service and API routes (issue #275)
 *
 * INTERIM STATE (pipelines engine retirement, migration 0053): the graph is
 * connection-nodes only — see server/services/inventory.ts's file-level note
 * and follow-up #54 for the planned skill/model-registry-backed redesign.
 *
 * Coverage:
 * - Graph construction (connection nodes + orphan flag)
 * - Orphan detection (unused 30d+ connections)
 * - Inventory API routes (2 endpoints)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemStorage } from "../../server/storage";
import {
  buildInventoryGraph,
  getOrphanNodes,
  ORPHAN_DAYS,
} from "../../server/services/inventory";
import type {
  CreateWorkspaceConnectionInput,
  RecordMcpToolCallInput,
} from "../../shared/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStorage(): InstanceType<typeof MemStorage> {
  return new MemStorage();
}

function makeConnInput(
  overrides: Partial<CreateWorkspaceConnectionInput> = {},
): CreateWorkspaceConnectionInput {
  return {
    workspaceId: "ws-1",
    type: "github",
    name: "GitHub Conn",
    config: {},
    ...overrides,
  };
}

/** Returns a nowMs that is 31 days in the future relative to the tool call date. */
function futureNowMs(callDate: Date): number {
  return callDate.getTime() + (ORPHAN_DAYS + 1) * 24 * 60 * 60 * 1000;
}

/** Returns nowMs equal to the tool call date (so connection is NOT orphaned). */
function recentNowMs(callDate: Date): number {
  return callDate.getTime();
}

// ─── Graph construction ───────────────────────────────────────────────────────

describe("buildInventoryGraph", () => {
  it("returns empty graph when workspace has no connections", async () => {
    const storage = makeStorage();
    const graph = await buildInventoryGraph(storage, "ws-empty");
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("creates a connection node for each workspace connection", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput());
    const graph = await buildInventoryGraph(storage, "ws-1");

    const connNode = graph.nodes.find((n) => n.id === conn.id);
    expect(connNode).toBeDefined();
    expect(connNode?.type).toBe("connection");
    expect(connNode?.label).toBe("GitHub Conn");
    expect(connNode?.metadata.connectionType).toBe("github");
    expect(connNode?.metadata.status).toBe("active");
  });
});

// ─── Orphan detection ─────────────────────────────────────────────────────────

describe("getOrphanNodes", () => {
  it("flags connection as orphan when it has never had any tool calls", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput());
    const nowMs = Date.now();

    const orphans = await getOrphanNodes(storage, "ws-1", nowMs);
    expect(orphans.some((n) => n.id === conn.id)).toBe(true);
  });

  it("does not flag connection as orphan when it had recent activity", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput());
    const callDate = new Date();

    await storage.recordMcpToolCall({
      connectionId: conn.id,
      toolName: "list_repos",
      argsJson: {},
      durationMs: 100,
      startedAt: callDate,
    });

    // nowMs = same as call date → within threshold
    const nowMs = recentNowMs(callDate);
    const orphans = await getOrphanNodes(storage, "ws-1", nowMs);
    expect(orphans.some((n) => n.id === conn.id)).toBe(false);
  });

  it("flags connection as orphan when last activity was more than 30 days ago", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput());
    const callDate = new Date();

    await storage.recordMcpToolCall({
      connectionId: conn.id,
      toolName: "list_repos",
      argsJson: {},
      durationMs: 100,
      startedAt: callDate,
    });

    // Advance now by 31 days
    const nowMs = futureNowMs(callDate);
    const orphans = await getOrphanNodes(storage, "ws-1", nowMs);
    expect(orphans.some((n) => n.id === conn.id)).toBe(true);
  });

  it("returns only connection nodes", async () => {
    const storage = makeStorage();
    await storage.createWorkspaceConnection(makeConnInput());

    const orphans = await getOrphanNodes(storage, "ws-1", Date.now());
    expect(orphans.every((n) => n.type === "connection")).toBe(true);
  });

  it("returns only connections that belong to the requested workspace", async () => {
    const storage = makeStorage();
    const connWs1 = await storage.createWorkspaceConnection(makeConnInput({ workspaceId: "ws-1" }));
    const connWs2 = await storage.createWorkspaceConnection(makeConnInput({ workspaceId: "ws-2" }));
    const nowMs = Date.now();

    const orphansWs1 = await getOrphanNodes(storage, "ws-1", nowMs);
    const ids = orphansWs1.map((n) => n.id);
    expect(ids).toContain(connWs1.id);
    expect(ids).not.toContain(connWs2.id);
  });
});

// ─── buildInventoryGraph – orphan flag ───────────────────────────────────────

describe("buildInventoryGraph orphan flag", () => {
  it("sets isOrphan=true on connection node with no recent activity", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput());
    const graph = await buildInventoryGraph(storage, "ws-1", Date.now());

    const node = graph.nodes.find((n) => n.id === conn.id);
    expect(node?.isOrphan).toBe(true);
  });

  it("sets isOrphan=false on connection with recent activity", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput());
    const callDate = new Date();

    await storage.recordMcpToolCall({
      connectionId: conn.id,
      toolName: "list_prs",
      argsJson: {},
      durationMs: 50,
      startedAt: callDate,
    });

    const graph = await buildInventoryGraph(storage, "ws-1", recentNowMs(callDate));
    const node = graph.nodes.find((n) => n.id === conn.id);
    expect(node?.isOrphan).toBe(false);
  });
});

// ─── buildInventoryGraph edge cases ───────────────────────────────────────────

describe("buildInventoryGraph edge cases", () => {
  it("handles multiple workspaces independently", async () => {
    const storage = makeStorage();
    await storage.createWorkspaceConnection(makeConnInput({ workspaceId: "ws-A", name: "A Conn" }));
    await storage.createWorkspaceConnection(makeConnInput({ workspaceId: "ws-B", name: "B Conn" }));

    const graphA = await buildInventoryGraph(storage, "ws-A");
    const graphB = await buildInventoryGraph(storage, "ws-B");

    expect(graphA.nodes.filter((n) => n.type === "connection").map((n) => n.label)).toContain("A Conn");
    expect(graphA.nodes.filter((n) => n.type === "connection").map((n) => n.label)).not.toContain("B Conn");

    expect(graphB.nodes.filter((n) => n.type === "connection").map((n) => n.label)).toContain("B Conn");
    expect(graphB.nodes.filter((n) => n.type === "connection").map((n) => n.label)).not.toContain("A Conn");
  });
});

// ─── ORPHAN_DAYS constant ─────────────────────────────────────────────────────

describe("ORPHAN_DAYS constant", () => {
  it("is 30", () => {
    expect(ORPHAN_DAYS).toBe(30);
  });
});
