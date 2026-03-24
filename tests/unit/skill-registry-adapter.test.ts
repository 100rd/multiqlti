import { describe, it, expect, vi } from "vitest";
import type {
  SkillRegistryAdapter,
  ExternalSkillResult,
  ExternalSkillDetails,
  InstalledSkillResult,
  SkillUpdateInfo,
} from "../../server/skill-market/types.js";

// ─── Mock Adapter ───────────────────────────────────────────────────────────

/**
 * In-memory mock implementation of SkillRegistryAdapter.
 * Verifies that the interface contract is correctly implementable.
 */
class MockRegistryAdapter implements SkillRegistryAdapter {
  id = "mock";
  name = "Mock Registry";
  icon = "https://example.com/icon.png";
  enabled = true;

  private skills: ExternalSkillDetails[] = [
    {
      externalId: "ext-skill-1",
      name: "Auto-Format",
      description: "Formats code automatically",
      author: "alice",
      version: "2.1.0",
      tags: ["formatting", "code"],
      popularity: 42,
      source: "mock",
      readme: "# Auto-Format\nGreat skill.",
      license: "MIT",
    },
    {
      externalId: "ext-skill-2",
      name: "Lint Helper",
      description: "Linting assistant",
      author: "bob",
      version: "1.0.0",
      tags: ["lint", "code"],
      popularity: 7,
      source: "mock",
    },
  ];

  async search(query: string): Promise<ExternalSkillResult> {
    const q = query.toLowerCase();
    const items = this.skills
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags.some((t) => t.includes(q)),
      )
      .map((s) => ({
        externalId: s.externalId,
        name: s.name,
        description: s.description,
        author: s.author,
        version: s.version,
        tags: s.tags,
        popularity: s.popularity,
        source: s.source,
      }));

    return { items, total: items.length, source: this.id };
  }

  async getDetails(externalId: string): Promise<ExternalSkillDetails> {
    const skill = this.skills.find((s) => s.externalId === externalId);
    if (!skill) throw new Error(`Skill ${externalId} not found`);
    return skill;
  }

  async install(externalId: string, userId: string): Promise<InstalledSkillResult> {
    const skill = this.skills.find((s) => s.externalId === externalId);
    if (!skill) throw new Error(`Skill ${externalId} not found`);
    return {
      localSkillId: `local-${externalId}-${userId}`,
      externalId,
      externalVersion: skill.version,
      source: this.id,
      installedAt: new Date(),
    };
  }

  async uninstall(_localSkillId: string): Promise<void> {
    // no-op in mock
  }

  async checkUpdates(
    installed: Array<{ externalId: string; externalVersion?: string }>,
  ): Promise<SkillUpdateInfo[]> {
    const updates: SkillUpdateInfo[] = [];
    for (const item of installed) {
      const skill = this.skills.find((s) => s.externalId === item.externalId);
      if (skill && item.externalVersion && item.externalVersion !== skill.version) {
        updates.push({
          externalId: item.externalId,
          currentVersion: item.externalVersion,
          latestVersion: skill.version,
        });
      }
    }
    return updates;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    return { ok: true, latencyMs: 1 };
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SkillRegistryAdapter (mock implementation)", () => {
  const adapter = new MockRegistryAdapter();

  it("search returns ExternalSkillResult matching query", async () => {
    const result = await adapter.search("format");
    expect(result.source).toBe("mock");
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("Auto-Format");
    expect(result.total).toBe(1);
  });

  it("search returns empty result for no match", async () => {
    const result = await adapter.search("zzzznonexistent");
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("getDetails returns ExternalSkillDetails for valid id", async () => {
    const details = await adapter.getDetails("ext-skill-1");
    expect(details.externalId).toBe("ext-skill-1");
    expect(details.name).toBe("Auto-Format");
    expect(details.author).toBe("alice");
    expect(details.version).toBe("2.1.0");
    expect(details.readme).toBeDefined();
    expect(details.license).toBe("MIT");
  });

  it("getDetails throws for unknown id", async () => {
    await expect(adapter.getDetails("unknown")).rejects.toThrow(
      "Skill unknown not found",
    );
  });

  it("install returns InstalledSkillResult", async () => {
    const result = await adapter.install("ext-skill-1", "user-42");
    expect(result.localSkillId).toContain("ext-skill-1");
    expect(result.localSkillId).toContain("user-42");
    expect(result.externalId).toBe("ext-skill-1");
    expect(result.externalVersion).toBe("2.1.0");
    expect(result.source).toBe("mock");
    expect(result.installedAt).toBeInstanceOf(Date);
  });

  it("install throws for unknown skill", async () => {
    await expect(adapter.install("unknown", "user-1")).rejects.toThrow(
      "Skill unknown not found",
    );
  });

  it("uninstall completes without error", async () => {
    await expect(adapter.uninstall("local-ext-skill-1-user-42")).resolves.toBeUndefined();
  });

  it("checkUpdates detects version mismatch", async () => {
    const updates = await adapter.checkUpdates([
      { externalId: "ext-skill-1", externalVersion: "1.0.0" },
      { externalId: "ext-skill-2", externalVersion: "1.0.0" },
    ]);
    // ext-skill-1 is at 2.1.0, so it should flag an update
    expect(updates).toHaveLength(1);
    expect(updates[0].externalId).toBe("ext-skill-1");
    expect(updates[0].currentVersion).toBe("1.0.0");
    expect(updates[0].latestVersion).toBe("2.1.0");
  });

  it("checkUpdates returns empty when all up-to-date", async () => {
    const updates = await adapter.checkUpdates([
      { externalId: "ext-skill-1", externalVersion: "2.1.0" },
    ]);
    expect(updates).toHaveLength(0);
  });

  it("healthCheck returns status", async () => {
    const health = await adapter.healthCheck();
    expect(health.ok).toBe(true);
    expect(typeof health.latencyMs).toBe("number");
  });
});
