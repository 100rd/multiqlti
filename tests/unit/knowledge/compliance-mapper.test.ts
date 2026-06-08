/**
 * Unit tests for the thin compliance mapper.
 *
 * loadGraph() reads a SERVER-RESOLVED constant path (never request-derived),
 * caps file size + bounds parse, caches the parsed graph once, and degrades
 * gracefully (missing / malformed / oversized → null, never throws). mapCard()
 * produces a coarse followed/violated/unknown heuristic with honest unknowns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import {
  loadGraph,
  mapCard,
  resetGraphCache,
  resolveGraphPath,
  type ComplianceGraph,
} from "../../../server/knowledge/compliance-mapper";
import type { PracticeCardRow } from "@shared/schema";

const FIXTURE = path.resolve(__dirname, "../../fixtures/graph-sample.json");

function card(overrides: Partial<PracticeCardRow> = {}): PracticeCardRow {
  return {
    id: "card-1",
    workspaceId: "ws-1",
    topic: "terraform-module-best-practices",
    statement: "Use remote state backend with locking.",
    rationale: "Prevents concurrent state corruption.",
    appliesTo: { tool: "terraform", resourceKinds: ["module", "backend"], tags: ["state"] },
    sources: [],
    confidence: 0.8,
    status: "active",
    supersedes: [],
    supersededBy: [],
    ingestedBy: "researcher",
    ingestedByUserId: "u1",
    verifiedBy: "validator",
    verifiedByUserId: "u2",
    verification: {},
    reviewState: "accepted",
    contentHash: "h",
    lastVerifiedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("loadGraph — happy path + cache", () => {
  beforeEach(() => resetGraphCache());

  it("loads and parses the fixture graph", async () => {
    const graph = await loadGraph(FIXTURE);
    expect(graph).not.toBeNull();
    expect(graph?.nodes.length).toBeGreaterThan(5);
  });

  it("caches the parsed graph (second load survives file deletion)", async () => {
    const fs = await import("node:fs/promises");
    const tmp = path.resolve(__dirname, "../../fixtures/graph-cache-tmp.json");
    await fs.copyFile(FIXTURE, tmp);

    const first = await loadGraph(tmp);
    expect(first).not.toBeNull();

    // Delete the underlying file — a cached read must still succeed.
    await fs.rm(tmp, { force: true });
    const second = await loadGraph(tmp);
    expect(second).toBe(first); // same cached reference, no re-read
  });
});

describe("loadGraph — graceful degradation", () => {
  beforeEach(() => resetGraphCache());

  it("returns null for a missing file (no throw)", async () => {
    const graph = await loadGraph("/nonexistent/definitely/not/here.json");
    expect(graph).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const bad = path.resolve(__dirname, "../../fixtures/graph-invalid.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(bad, "{ not valid json ", "utf8");
    const graph = await loadGraph(bad);
    expect(graph).toBeNull();
    await fs.rm(bad, { force: true });
  });

  it("returns null when the JSON is missing the nodes key", async () => {
    const bad = path.resolve(__dirname, "../../fixtures/graph-nonodes.json");
    const fs = await import("node:fs/promises");
    await fs.writeFile(bad, JSON.stringify({ directed: false, links: [] }), "utf8");
    const graph = await loadGraph(bad);
    expect(graph).toBeNull();
    await fs.rm(bad, { force: true });
  });

  it("returns null when the file exceeds the size cap", async () => {
    const graph = await loadGraph(FIXTURE, 10); // 10 bytes — fixture is larger
    expect(graph).toBeNull();
  });
});

describe("mapCard — heuristic mapping", () => {
  function fixtureGraph(): ComplianceGraph {
    return {
      nodes: [
        { id: "mod", label: "network module", source_file: "modules/network/main.tf" },
        { id: "backend", label: "remote state backend", source_file: "live/prod/backend.tf" },
        { id: "bucket", label: "logging bucket", source_file: "modules/storage/bucket.tf" },
        { id: "readme", label: "README", source_file: "README.md" },
        { id: "nosrc", label: "synthetic", source_file: undefined },
      ],
    };
  }

  it("maps terraform .tf nodes and classifies followed via keyword match", () => {
    const result = mapCard(
      card({ statement: "Use a remote state backend.", appliesTo: { tool: "terraform", tags: ["state", "backend"] } }),
      fixtureGraph(),
    );
    expect(result.cardId).toBe("card-1");
    const followedFiles = result.followed.map((n) => n.source_file);
    expect(followedFiles).toContain("live/prod/backend.tf");
  });

  it("nodes in scope but without keyword evidence are unknown (honest)", () => {
    const result = mapCard(
      card({ statement: "Pin module source versions.", appliesTo: { tool: "terraform", tags: ["versioning"] } }),
      fixtureGraph(),
    );
    // .tf nodes with no version keyword evidence → unknown, never false 'followed'.
    expect(result.unknown.length).toBeGreaterThan(0);
    expect(result.violated).toEqual([]);
  });

  it("ignores non-terraform files (README) entirely", () => {
    const result = mapCard(card(), fixtureGraph());
    const allFiles = [...result.followed, ...result.violated, ...result.unknown].map((n) => n.source_file);
    expect(allFiles).not.toContain("README.md");
  });

  it("nodes missing source_file are not mapped", () => {
    const result = mapCard(card(), fixtureGraph());
    const allIds = [...result.followed, ...result.violated, ...result.unknown].map((n) => n.id);
    expect(allIds).not.toContain("nosrc");
  });

  it("a non-terraform card maps to all-empty (unknown only / nothing)", () => {
    const result = mapCard(
      card({ appliesTo: { tool: "kubernetes" } as PracticeCardRow["appliesTo"] }),
      fixtureGraph(),
    );
    expect(result.followed).toEqual([]);
    expect(result.violated).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it("returns all-empty when the graph is null (feature disabled)", () => {
    const result = mapCard(card(), null);
    expect(result).toEqual({ cardId: "card-1", statement: card().statement, followed: [], violated: [], unknown: [] });
  });
});

describe("resolveGraphPath — cjs-safe default (no import.meta)", () => {
  const original = process.env.KB_INFRA_GRAPH_PATH;
  afterEach(() => {
    if (original === undefined) delete process.env.KB_INFRA_GRAPH_PATH;
    else process.env.KB_INFRA_GRAPH_PATH = original;
  });

  it("returns a non-empty absolute string for the default (no env override)", () => {
    delete process.env.KB_INFRA_GRAPH_PATH;
    const resolved = resolveGraphPath();
    // The cjs prod bundle has an empty import.meta.url; the default must NOT
    // collapse to a relative './infra/...' rooted at "" — it must be absolute.
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join("infra", "graphify-out", "graph.json"))).toBe(true);
  });

  it("honors the KB_INFRA_GRAPH_PATH env override", () => {
    process.env.KB_INFRA_GRAPH_PATH = "/custom/graph.json";
    expect(resolveGraphPath()).toBe("/custom/graph.json");
  });
});
