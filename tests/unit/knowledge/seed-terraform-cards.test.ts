/**
 * Unit tests for the example Terraform-cards seeder.
 *
 * Covers: dataset integrity (count, distinct provenance, accepted/active fields),
 * idempotency (running twice creates no duplicates), and the BEST-EFFORT
 * projection contract (a failing/absent embedding provider must NOT throw and
 * must still persist every card).
 */
import { describe, it, expect, vi } from "vitest";
import { MemStorage } from "../../../server/storage";
import {
  seedExampleTerraformCards,
  resolveFirstAdminUserId,
  EXAMPLE_TERRAFORM_CARDS,
  EXAMPLE_WORKSPACE_NAME,
  EXAMPLE_TOPIC,
  type ProjectionRunner,
} from "../../../server/knowledge/seed-terraform-cards";

function mockProjection(): ProjectionRunner {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    insertChunks: vi.fn().mockResolvedValue([{ id: "chunk" }]),
    dimensions: 4,
    model: "mock-embed",
    provider: "mock",
  };
}

describe("EXAMPLE_TERRAFORM_CARDS — dataset integrity", () => {
  it("has 12-15+ genuine cards, all terraform-scoped", () => {
    expect(EXAMPLE_TERRAFORM_CARDS.length).toBeGreaterThanOrEqual(12);
    for (const c of EXAMPLE_TERRAFORM_CARDS) {
      expect(c.appliesTo.tool).toBe("terraform");
      expect(c.statement.length).toBeGreaterThan(0);
      expect(c.rationale.length).toBeGreaterThan(0);
      expect(c.sources.length).toBeGreaterThan(0);
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("seedExampleTerraformCards — persistence + provenance", () => {
  it("creates the example workspace and inserts every card as accepted/active", async () => {
    const storage = new MemStorage();
    const result = await seedExampleTerraformCards(storage, {
      buildProjection: async () => mockProjection(),
    });

    expect(result.created).toBe(EXAMPLE_TERRAFORM_CARDS.length);
    expect(result.alreadyPresent).toBe(0);
    expect(result.projected).toBe(EXAMPLE_TERRAFORM_CARDS.length);
    expect(result.projectionSkipped).toBe(false);

    const workspaces = await storage.getWorkspaces();
    expect(workspaces.some((w) => w.name === EXAMPLE_WORKSPACE_NAME)).toBe(true);

    const { cards } = await storage.listPracticeCards(result.workspaceId, { limit: 200 });
    expect(cards.length).toBe(EXAMPLE_TERRAFORM_CARDS.length);
    for (const card of cards) {
      expect(card.status).toBe("active");
      expect(card.reviewState).toBe("accepted");
      expect(card.topic).toBe(EXAMPLE_TOPIC);
      // Distinct provenance: ingester label differs from verifier label.
      expect(card.ingestedBy).not.toBe(card.verifiedBy);
      expect(card.ingestedByUserId).toBeTruthy();
    }
  });
});

describe("seedExampleTerraformCards — idempotency", () => {
  it("running twice creates no duplicates and reuses the same workspace", async () => {
    const storage = new MemStorage();
    const first = await seedExampleTerraformCards(storage, { buildProjection: async () => mockProjection() });
    const second = await seedExampleTerraformCards(storage, { buildProjection: async () => mockProjection() });

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.created).toBe(0);
    expect(second.alreadyPresent).toBe(EXAMPLE_TERRAFORM_CARDS.length);

    const { total } = await storage.listPracticeCards(first.workspaceId, { limit: 200 });
    expect(total).toBe(EXAMPLE_TERRAFORM_CARDS.length);

    const workspaces = (await storage.getWorkspaces()).filter((w) => w.name === EXAMPLE_WORKSPACE_NAME);
    expect(workspaces).toHaveLength(1);
  });
});

describe("seedExampleTerraformCards — best-effort projection", () => {
  it("does NOT throw and still persists cards when the embedding provider fails", async () => {
    const storage = new MemStorage();
    const logged: string[] = [];
    const result = await seedExampleTerraformCards(storage, {
      buildProjection: async () => {
        throw new Error("Ollama unreachable");
      },
      log: (m) => logged.push(m),
    });

    expect(result.created).toBe(EXAMPLE_TERRAFORM_CARDS.length);
    expect(result.projectionSkipped).toBe(true);
    expect(result.projected).toBe(0);
    expect(logged.join(" ")).toContain("re-embed");

    const { total } = await storage.listPracticeCards(result.workspaceId, { limit: 200 });
    expect(total).toBe(EXAMPLE_TERRAFORM_CARDS.length);
  });

  it("skips projection cleanly when the builder returns null (no provider configured)", async () => {
    const storage = new MemStorage();
    const result = await seedExampleTerraformCards(storage, {
      buildProjection: async () => null,
    });
    expect(result.projectionSkipped).toBe(true);
    expect(result.projected).toBe(0);
    expect(result.created).toBe(EXAMPLE_TERRAFORM_CARDS.length);
  });

  it("binds the example workspace owner to the supplied adminUserId", async () => {
    const storage = new MemStorage();
    const result = await seedExampleTerraformCards(storage, {
      adminUserId: "admin-42",
      buildProjection: async () => null,
    });
    const ws = await storage.getWorkspace(result.workspaceId);
    expect(ws?.ownerId).toBe("admin-42");
  });
});

describe("seedExampleTerraformCards — owner resolution precedence", () => {
  it("uses resolveAdminUserId when adminUserId is not given", async () => {
    const storage = new MemStorage();
    const result = await seedExampleTerraformCards(storage, {
      resolveAdminUserId: async () => "resolved-admin",
      buildProjection: async () => null,
    });
    const ws = await storage.getWorkspace(result.workspaceId);
    expect(ws?.ownerId).toBe("resolved-admin");
  });

  it("leaves the workspace owner null when no admin can be resolved", async () => {
    const storage = new MemStorage();
    const result = await seedExampleTerraformCards(storage, {
      resolveAdminUserId: async () => null,
      buildProjection: async () => null,
    });
    const ws = await storage.getWorkspace(result.workspaceId);
    expect(ws?.ownerId).toBeNull();
    // Card provenance still carries a non-null (system) ingester id.
    const { cards } = await storage.listPracticeCards(result.workspaceId, { limit: 200 });
    expect(cards.every((c) => !!c.ingestedByUserId)).toBe(true);
  });
});

describe("resolveFirstAdminUserId — graceful without a DB", () => {
  it("resolves to null instead of throwing when the DB is unavailable", async () => {
    // In the unit environment there is no configured Postgres; the helper must
    // swallow the failure and return null so seeding can still proceed.
    const result = await resolveFirstAdminUserId();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
