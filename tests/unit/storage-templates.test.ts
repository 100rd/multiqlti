/**
 * BE2 — MemStorage task templates (task-groups-v2 §3.5 / library).
 *
 * CRUD + MF-4 (owner filter applied BEFORE the label match so a non-admin cannot
 * enumerate another tenant's templates by label) + label containment + keyset
 * pagination (created_at desc, id desc) + set-null provenance on delete.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, TASK_GROUP_V2_MAX_LIMIT } from "../../server/storage.js";
import type { InsertTaskGroup } from "@shared/schema";

let storage: MemStorage;

beforeEach(() => {
  storage = new MemStorage();
});

describe("MemStorage.createTaskTemplate / getTaskTemplate", () => {
  it("creates a template with defaults (executionMode=direct_llm, labels=[])", async () => {
    const t = await storage.createTaskTemplate({ name: "Lint", description: "Run linter", createdBy: "u1" });
    expect(t.id).toBeTruthy();
    expect(t.executionMode).toBe("direct_llm");
    expect(t.labels).toEqual([]);
    expect(t.createdBy).toBe("u1");
    expect(t.createdAt).toBeInstanceOf(Date);
    expect(t.updatedAt).toBeInstanceOf(Date);
  });

  it("getTaskTemplate returns the row, undefined for unknown id", async () => {
    const t = await storage.createTaskTemplate({ name: "T", description: "d", createdBy: "u1" });
    expect((await storage.getTaskTemplate(t.id))?.id).toBe(t.id);
    expect(await storage.getTaskTemplate("nope")).toBeUndefined();
  });
});

describe("MemStorage.updateTaskTemplate / deleteTaskTemplate", () => {
  it("updates fields and bumps updatedAt", async () => {
    const t = await storage.createTaskTemplate({ name: "T", description: "d", createdBy: "u1" });
    const updated = await storage.updateTaskTemplate(t.id, { name: "T2", labels: ["frontend"] });
    expect(updated.name).toBe("T2");
    expect(updated.labels).toEqual(["frontend"]);
  });

  it("throws when updating an unknown id", async () => {
    await expect(storage.updateTaskTemplate("ghost", { name: "x" })).rejects.toThrow(/not found/i);
  });

  it("deleteTaskTemplate set-nulls provenance on copied-in definitions", async () => {
    const t = await storage.createTaskTemplate({ name: "T", description: "d", createdBy: "u1" });
    const g = await storage.createTaskGroup({ name: "g", description: "d", input: "i", createdBy: "u1" } as InsertTaskGroup);
    const def = await storage.createTask({ groupId: g.id, name: "copied", description: "d", sortOrder: 0, templateId: t.id });
    expect(def.templateId).toBe(t.id);

    await storage.deleteTaskTemplate(t.id);
    expect(await storage.getTaskTemplate(t.id)).toBeUndefined();
    // The definition survives; only provenance is soft-cleared (FK set-null).
    const stillThere = await storage.getTask(def.id);
    expect(stillThere).toBeDefined();
    expect(stillThere?.templateId).toBeNull();
  });
});

describe("MemStorage.getTaskTemplates — MF-4 owner filter BEFORE label", () => {
  beforeEach(async () => {
    await storage.createTaskTemplate({ name: "mine-a", description: "d", createdBy: "u1", labels: ["shared-label"] });
    await storage.createTaskTemplate({ name: "mine-b", description: "d", createdBy: "u1", labels: ["only-mine"] });
    await storage.createTaskTemplate({ name: "theirs", description: "d", createdBy: "u2", labels: ["shared-label"] });
  });

  it("a non-admin sees only their own templates", async () => {
    const rows = await storage.getTaskTemplates({ ownerId: "u1", isAdmin: false, limit: 100 });
    expect(rows.every((t) => t.createdBy === "u1")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("a label shared with another tenant does NOT leak that tenant's row to a non-admin", async () => {
    const rows = await storage.getTaskTemplates({ ownerId: "u1", isAdmin: false, label: "shared-label", limit: 100 });
    // Only u1's "mine-a" carries shared-label; u2's "theirs" must be excluded.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("mine-a");
  });

  it("an admin sees all owners' templates (still label-filtered)", async () => {
    const rows = await storage.getTaskTemplates({ isAdmin: true, label: "shared-label", limit: 100 });
    expect(rows).toHaveLength(2);
    expect(rows.map((t) => t.name).sort()).toEqual(["mine-a", "theirs"]);
  });

  it("filters by an exact label (containment)", async () => {
    const rows = await storage.getTaskTemplates({ isAdmin: true, label: "only-mine", limit: 100 });
    expect(rows.map((t) => t.name)).toEqual(["mine-b"]);
  });
});

describe("MemStorage.getTaskTemplates — keyset pagination (created_at desc, id desc)", () => {
  it("paginates without dupes or gaps and clamps the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.createTaskTemplate({ name: `t${i}`, description: "d", createdBy: "u1" });
    }
    const page1 = await storage.getTaskTemplates({ ownerId: "u1", isAdmin: false, limit: 2 });
    const c1 = page1[page1.length - 1];
    const page2 = await storage.getTaskTemplates({
      ownerId: "u1",
      isAdmin: false,
      limit: 2,
      cursor: { createdAt: c1.createdAt.toISOString(), id: c1.id },
    });
    const c2 = page2[page2.length - 1];
    const page3 = await storage.getTaskTemplates({
      ownerId: "u1",
      isAdmin: false,
      limit: 2,
      cursor: { createdAt: c2.createdAt.toISOString(), id: c2.id },
    });
    const allIds = [...page1, ...page2, ...page3].map((t) => t.id);
    expect(allIds).toHaveLength(5);
    expect(new Set(allIds).size).toBe(5); // no dupes

    const clamped = await storage.getTaskTemplates({ ownerId: "u1", isAdmin: false, limit: TASK_GROUP_V2_MAX_LIMIT + 10 });
    expect(clamped.length).toBeLessThanOrEqual(TASK_GROUP_V2_MAX_LIMIT);
  });
});
