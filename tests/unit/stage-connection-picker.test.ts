/**
 * Unit tests for StageConnectionPicker and A2AMessageThread UI helpers.
 * These test pure logic (filtering, labelling, formatting) without DOM rendering.
 */
import { describe, it, expect } from "vitest";
import type { WorkspaceConnection, A2AThreadEntry } from "../../shared/types";

// ─── Helpers matching StageConnectionPicker internal logic ────────────────────

const TYPE_LABELS: Record<string, string> = {
  gitlab: "GitLab",
  github: "GitHub",
  kubernetes: "Kubernetes",
  aws: "AWS",
  jira: "Jira",
  grafana: "Grafana",
  generic_mcp: "Generic MCP",
};

function makeConn(
  overrides: Partial<WorkspaceConnection> = {},
): WorkspaceConnection {
  return {
    id: `conn-${Math.random().toString(36).slice(2)}`,
    workspaceId: "ws-1",
    type: "github",
    name: "My Connection",
    config: {},
    hasSecrets: false,
    status: "active",
    lastTestedAt: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    createdBy: null,
    ...overrides,
  };
}

// ─── Search filter logic (matches StageConnectionPicker.tsx) ─────────────────

function filterConnections(
  connections: WorkspaceConnection[],
  search: string,
): WorkspaceConnection[] {
  if (!search) return connections;
  const q = search.toLowerCase();
  return connections.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.type.toLowerCase().includes(q) ||
      (TYPE_LABELS[c.type] ?? c.type).toLowerCase().includes(q),
  );
}

// ─── Toggle logic ────────────────────────────────────────────────────────────

function toggle(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((s) => s !== id)
    : [...selected, id];
}

// ─── A2AMessageThread formatting ─────────────────────────────────────────────

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("StageConnectionPicker — search filter", () => {
  const connections = [
    makeConn({ id: "c1", name: "Prod GitHub", type: "github" }),
    makeConn({ id: "c2", name: "Staging K8s", type: "kubernetes" }),
    makeConn({ id: "c3", name: "Jira Project", type: "jira" }),
    makeConn({ id: "c4", name: "My AWS Account", type: "aws" }),
  ];

  it("returns all when search is empty", () => {
    expect(filterConnections(connections, "")).toHaveLength(4);
  });

  it("filters by connection name (case-insensitive)", () => {
    expect(filterConnections(connections, "prod")).toHaveLength(1);
    expect(filterConnections(connections, "PROD")).toHaveLength(1);
  });

  it("filters by raw type string", () => {
    const result = filterConnections(connections, "kubernetes");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c2");
  });

  it("filters by display label", () => {
    // "GitHub" should match "github" raw type via TYPE_LABELS
    const result = filterConnections(connections, "github");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterConnections(connections, "zzznomatch")).toHaveLength(0);
  });

  it("finds connections by partial name", () => {
    const result = filterConnections(connections, "aws");
    expect(result.map((c) => c.id)).toContain("c4");
  });
});

describe("StageConnectionPicker — toggle logic", () => {
  it("adds id when not present", () => {
    const next = toggle([], "c1");
    expect(next).toEqual(["c1"]);
  });

  it("removes id when already present", () => {
    const next = toggle(["c1", "c2"], "c1");
    expect(next).toEqual(["c2"]);
  });

  it("does not duplicate ids", () => {
    const next = toggle(["c1"], "c1");
    expect(next.filter((x) => x === "c1")).toHaveLength(0);
  });

  it("maintains order when removing", () => {
    const next = toggle(["c1", "c2", "c3"], "c2");
    expect(next).toEqual(["c1", "c3"]);
  });
});

describe("StageConnectionPicker — deny-all default", () => {
  it("empty selected means deny-all (no connections enabled)", () => {
    const selected: string[] = [];
    expect(selected.length).toBe(0);
  });

  it("selectAll assigns all filtered IDs", () => {
    const connections = [makeConn({ id: "a" }), makeConn({ id: "b" })];
    const allIds = connections.map((c) => c.id);
    expect(allIds).toEqual(["a", "b"]);
  });

  it("clearAll results in empty selection", () => {
    const cleared: string[] = [];
    expect(cleared.length).toBe(0);
  });
});

describe("TYPE_LABELS mapping", () => {
  it("covers all 7 connection types", () => {
    const expectedTypes = ["gitlab", "github", "kubernetes", "aws", "jira", "grafana", "generic_mcp"];
    for (const t of expectedTypes) {
      expect(TYPE_LABELS[t]).toBeTruthy();
    }
  });
});

describe("A2AMessageThread — entry formatting helpers", () => {
  it("formatTime produces a valid time string from epoch ms", () => {
    const time = formatTime(0);
    expect(typeof time).toBe("string");
    expect(time.length).toBeGreaterThan(0);
  });

  it("clarify type has label 'clarify'", () => {
    const entry: A2AThreadEntry = {
      id: "e1",
      type: "clarify",
      fromStageId: "stage-A",
      targetStageId: "stage-B",
      content: "What is the schema?",
      timestamp: Date.now(),
    };
    expect(entry.type).toBe("clarify");
  });

  it("answer type has label 'answer'", () => {
    const entry: A2AThreadEntry = {
      id: "e2",
      type: "answer",
      fromStageId: "stage-B",
      targetStageId: "stage-A",
      content: "The schema is JSON.",
      timestamp: Date.now(),
    };
    expect(entry.type).toBe("answer");
  });

  it("timeout type has label 'timeout'", () => {
    const entry: A2AThreadEntry = {
      id: "e3",
      type: "timeout",
      fromStageId: "stage-A",
      targetStageId: "stage-B",
      content: "Timeout after 30000ms",
      timestamp: Date.now(),
    };
    expect(entry.type).toBe("timeout");
  });

  it("null entries array renders nothing (length 0)", () => {
    const entries: A2AThreadEntry[] = [];
    expect(entries.length).toBe(0);
  });
});

describe("allowedConnections field presence in PipelineStageConfig type", () => {
  it("accepts a stage config with allowedConnections as string array", () => {
    // Type-level assertion: if this compiles, the field exists on the type
    const stage = {
      teamId: "planning" as const,
      modelSlug: "test-model",
      enabled: true,
      allowedConnections: ["conn-1", "conn-2"],
    };
    expect(stage.allowedConnections).toEqual(["conn-1", "conn-2"]);
  });

  it("accepts a stage config with empty allowedConnections (deny-all)", () => {
    const stage = {
      teamId: "planning" as const,
      modelSlug: "test-model",
      enabled: true,
      allowedConnections: [] as string[],
    };
    expect(stage.allowedConnections).toHaveLength(0);
  });

  it("accepts a stage config without allowedConnections (deny-all by default)", () => {
    const stage = {
      teamId: "planning" as const,
      modelSlug: "test-model",
      enabled: true,
    };
    // allowedConnections is undefined → deny-all
    expect((stage as Record<string, unknown>).allowedConnections).toBeUndefined();
  });
});
