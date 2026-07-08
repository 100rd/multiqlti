/**
 * Tests for inventory service and API routes (issue #275)
 *
 * Coverage:
 * - Graph construction (connection nodes + orphan flag)
 * - Orphan detection (unused 30d+ connections)
 * - Inventory API routes (2 endpoints)
 * - #54: skill/model registry nodes + compatible/uses edges (see
 *   server/services/inventory.ts's DERIVATION note for exact sourcing).
 *   Registry-sourced cases below run against both MemStorage (always) and
 *   PgStorage (gated behind DATABASE_URL), mirroring the parity-harness
 *   pattern in tests/integration/storage/mem-pg-parity.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemStorage } from "../../server/storage";
import type { IStorage } from "../../server/storage";
import {
  buildInventoryGraph,
  getOrphanNodes,
  ORPHAN_DAYS,
} from "../../server/services/inventory";
import type {
  CreateWorkspaceConnectionInput,
  RecordMcpToolCallInput,
} from "../../shared/types";
import type { InsertModel, InsertSkill, InsertModelSkillBinding } from "../../shared/schema";

const HAS_DATABASE = Boolean(process.env.DATABASE_URL);

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

/** A short unique suffix so PG runs (shared DB) don't collide across cases. */
function uniq(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeModelInput(overrides: Partial<InsertModel> = {}): InsertModel {
  const suffix = uniq();
  return {
    name: `Model ${suffix}`,
    slug: `model-${suffix}`,
    provider: "anthropic",
    isActive: true,
    ...overrides,
  } as InsertModel;
}

function makeSkillInput(overrides: Partial<InsertSkill> = {}): InsertSkill {
  const suffix = uniq();
  return {
    name: `Skill ${suffix}`,
    teamId: "team-1",
    sourceType: "manual",
    ...overrides,
  } as InsertSkill;
}

function makeBindingInput(
  modelId: string,
  skillId: string,
  overrides: Partial<InsertModelSkillBinding> = {},
): InsertModelSkillBinding {
  return { modelId, skillId, ...overrides } as InsertModelSkillBinding;
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

// ─── #54: registry-backed nodes/edges — dual-impl cases ───────────────────────
//
// One shared case table run against MemStorage (always) and PgStorage (gated
// behind DATABASE_URL), mirroring tests/integration/storage/mem-pg-parity.test.ts.

function runRegistryCases(label: string, makeGraphStorage: () => IStorage): void {
  describe(`buildInventoryGraph registries — ${label}`, () => {
    describe("skill nodes", () => {
      it("creates a skill node for every skill regardless of workspace", async () => {
        const storage = makeGraphStorage();
        const skill = await storage.createSkill(
          makeSkillInput({ name: "Code Review", sourceType: "git", gitSourceId: "git-src-1" }),
        );

        const graph = await buildInventoryGraph(storage, "ws-skills-1");

        const node = graph.nodes.find((n) => n.id === skill.id);
        expect(node).toBeDefined();
        expect(node?.type).toBe("skill");
        expect(node?.label).toBe("Code Review");
        expect(node?.metadata.sourceType).toBe("git");
        expect(node?.metadata.gitSourceId).toBe("git-src-1");
      });
    });

    describe("model nodes", () => {
      it("creates a model node surfacing provider and isActive", async () => {
        const storage = makeGraphStorage();
        const model = await storage.createModel(
          makeModelInput({ name: "Sonnet", provider: "anthropic", isActive: false }),
        );

        const graph = await buildInventoryGraph(storage, "ws-models-1");

        const node = graph.nodes.find((n) => n.id === model.id);
        expect(node).toBeDefined();
        expect(node?.type).toBe("model");
        expect(node?.label).toBe("Sonnet");
        expect(node?.metadata.provider).toBe("anthropic");
        expect(node?.metadata.isActive).toBe(false);
      });
    });

    describe("compatible edges (model <-> skill bindings)", () => {
      it("creates a compatible edge between a model and a bound skill via slug", async () => {
        const storage = makeGraphStorage();
        const model = await storage.createModel(makeModelInput());
        const skill = await storage.createSkill(makeSkillInput());
        await storage.createModelSkillBinding(makeBindingInput(model.slug, skill.id));

        const graph = await buildInventoryGraph(storage, "ws-bind-1");

        expect(graph.edges).toContainEqual({
          source: model.id,
          target: skill.id,
          relation: "compatible",
        });
      });

      it("resolves a binding keyed by the provider modelId (not slug)", async () => {
        const storage = makeGraphStorage();
        const model = await storage.createModel(
          makeModelInput({ modelId: `provider-${uniq()}` }),
        );
        const skill = await storage.createSkill(makeSkillInput());
        await storage.createModelSkillBinding(
          makeBindingInput(model.modelId as string, skill.id),
        );

        const graph = await buildInventoryGraph(storage, "ws-bind-2");

        expect(graph.edges).toContainEqual({
          source: model.id,
          target: skill.id,
          relation: "compatible",
        });
      });

      it("skips a binding whose modelId resolves to no known model", async () => {
        const storage = makeGraphStorage();
        const skill = await storage.createSkill(makeSkillInput());
        await storage.createModelSkillBinding(makeBindingInput("unknown-model-slug", skill.id));

        const graph = await buildInventoryGraph(storage, "ws-bind-3");

        expect(graph.edges.some((e) => e.relation === "compatible")).toBe(false);
      });
    });

    describe("uses edges (task -> model, sparse/best-effort)", () => {
      it("creates a uses edge for a task with matching workspaceId and a modelSlug", async () => {
        const storage = makeGraphStorage();
        const model = await storage.createModel(makeModelInput());
        const group = await storage.createTaskGroup({
          name: `group-${uniq()}`,
          description: "d",
          input: "the prompt",
        });
        const task = await storage.createTask({
          groupId: group.id,
          name: "t",
          description: "d",
          sortOrder: 0,
          workspaceId: "ws-uses-1",
          modelSlug: model.slug,
        });

        const graph = await buildInventoryGraph(storage, "ws-uses-1");

        expect(graph.edges).toContainEqual({
          source: task.id,
          target: model.id,
          relation: "uses",
        });
      });

      it("excludes a task whose workspaceId does not match the queried workspace", async () => {
        const storage = makeGraphStorage();
        const model = await storage.createModel(makeModelInput());
        const group = await storage.createTaskGroup({
          name: `group-${uniq()}`,
          description: "d",
          input: "the prompt",
        });
        await storage.createTask({
          groupId: group.id,
          name: "t",
          description: "d",
          sortOrder: 0,
          workspaceId: "ws-other",
          modelSlug: model.slug,
        });

        const graph = await buildInventoryGraph(storage, "ws-uses-2");

        expect(graph.edges.some((e) => e.relation === "uses")).toBe(false);
      });

      it("excludes a task with a null modelSlug even when workspaceId matches", async () => {
        const storage = makeGraphStorage();
        const group = await storage.createTaskGroup({
          name: `group-${uniq()}`,
          description: "d",
          input: "the prompt",
        });
        await storage.createTask({
          groupId: group.id,
          name: "t",
          description: "d",
          sortOrder: 0,
          workspaceId: "ws-uses-3",
        });

        const graph = await buildInventoryGraph(storage, "ws-uses-3");

        expect(graph.edges.some((e) => e.relation === "uses")).toBe(false);
      });
    });

    describe("mixed graph", () => {
      it("combines connection, skill, and model nodes with compatible + uses edges", async () => {
        const storage = makeGraphStorage();
        const wsId = `ws-mixed-${uniq()}`;
        const conn = await storage.createWorkspaceConnection(makeConnInput({ workspaceId: wsId }));
        const model = await storage.createModel(makeModelInput());
        const skill = await storage.createSkill(makeSkillInput());
        await storage.createModelSkillBinding(makeBindingInput(model.slug, skill.id));
        const group = await storage.createTaskGroup({
          name: `group-${uniq()}`,
          description: "d",
          input: "the prompt",
        });
        const task = await storage.createTask({
          groupId: group.id,
          name: "t",
          description: "d",
          sortOrder: 0,
          workspaceId: wsId,
          modelSlug: model.slug,
        });

        const graph = await buildInventoryGraph(storage, wsId);

        const nodeIds = graph.nodes.map((n) => n.id);
        expect(nodeIds).toContain(conn.id);
        expect(nodeIds).toContain(model.id);
        expect(nodeIds).toContain(skill.id);
        expect(graph.nodes.find((n) => n.id === conn.id)?.type).toBe("connection");
        expect(graph.edges).toContainEqual({ source: model.id, target: skill.id, relation: "compatible" });
        expect(graph.edges).toContainEqual({ source: task.id, target: model.id, relation: "uses" });
      });
    });

    describe("orphan connections alongside registry nodes", () => {
      it("still flags an unused connection as orphan when skill/model nodes are present", async () => {
        const storage = makeGraphStorage();
        const wsId = `ws-orphan-${uniq()}`;
        const conn = await storage.createWorkspaceConnection(makeConnInput({ workspaceId: wsId }));
        await storage.createModel(makeModelInput());
        await storage.createSkill(makeSkillInput());

        const graph = await buildInventoryGraph(storage, wsId, Date.now());

        const connNode = graph.nodes.find((n) => n.id === conn.id);
        expect(connNode?.isOrphan).toBe(true);
        // Skill/model nodes never carry an orphan flag (no comparable usage series).
        for (const node of graph.nodes.filter((n) => n.type !== "connection")) {
          expect(node.isOrphan).toBeUndefined();
        }
      });
    });
  });
}

// MemStorage: always runs (DB-free).
runRegistryCases("MemStorage", () => new MemStorage());

// PgStorage: registered only when DATABASE_URL is set (kept `./db`'s eager pg
// Pool construction out of the DB-free import path — same guard as the parity
// harness).
describe.skipIf(!HAS_DATABASE)("buildInventoryGraph registries — PgStorage gate", async () => {
  const { PgStorage } = await import("../../server/storage-pg");
  runRegistryCases("PgStorage", () => new PgStorage());
});
