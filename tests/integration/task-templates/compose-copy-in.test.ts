/**
 * Integration tests for composition COPY-IN (BE8, §5.3/§6):
 *   - create-from-template copies the template's fields + labels into the new
 *     `tasks` definition and stamps `template_id` (provenance);
 *   - SNAPSHOT INDEPENDENCE: editing OR deleting the template afterwards never
 *     mutates the group's definition (delete → `template_id` null, group still
 *     runnable);
 *   - cross-owner template is DENIED at compose (403) for both create and
 *     add-task — the run hot path never re-reads templates;
 *   - add-from-template copy-in via POST /:id/tasks.
 *
 * Deterministic: MemStorage + supertest, no real CLI/network/DB.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTaskGroupTestApp } from "../../helpers/test-task-group-app.js";
import type { MemStorage } from "../../../server/storage.js";

async function seedTemplate(storage: MemStorage, createdBy: string | null) {
  return storage.createTaskTemplate({
    name: "Tpl",
    description: "template description",
    executionMode: "direct_llm",
    modelSlug: "claude-opus",
    teamId: "team-x",
    input: { foo: "bar" },
    labels: ["research", "draft"],
    createdBy,
  });
}

describe("compose copy-in — POST /api/task-groups", () => {
  it("copies template fields + labels and stamps template_id", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const tpl = await seedTemplate(storage, "me");

    const res = await request(app)
      .post("/api/task-groups")
      .send({
        name: "G",
        description: "d",
        input: "objective",
        tasks: [{ name: "Step1", description: "manual override desc", templateId: tpl.id }],
      });
    expect(res.status).toBe(201);

    const tasks = await storage.getTasksByGroup(res.body.id);
    expect(tasks).toHaveLength(1);
    const t = tasks[0];
    // Copied from the template.
    expect(t.modelSlug).toBe("claude-opus");
    expect(t.teamId).toBe("team-x");
    expect(t.input).toEqual({ foo: "bar" });
    expect(t.labels).toEqual(["research", "draft"]);
    // Provenance stamped.
    expect(t.templateId).toBe(tpl.id);
    // name/description come from the create payload (group-graph concept).
    expect(t.name).toBe("Step1");
    expect(t.description).toBe("manual override desc");
  });

  it("snapshot independence: editing the template never mutates the group definition", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const tpl = await seedTemplate(storage, "me");
    const res = await request(app)
      .post("/api/task-groups")
      .send({ name: "G", description: "d", input: "obj", tasks: [{ name: "S", description: "x", templateId: tpl.id }] });
    const groupId = res.body.id;

    // Mutate the template AFTER compose.
    await storage.updateTaskTemplate(tpl.id, { modelSlug: "changed", labels: ["totally-different"] });

    const tasks = await storage.getTasksByGroup(groupId);
    expect(tasks[0].modelSlug).toBe("claude-opus");
    expect(tasks[0].labels).toEqual(["research", "draft"]);
  });

  it("snapshot independence: deleting the template nulls template_id but keeps the runnable definition", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const tpl = await seedTemplate(storage, "me");
    const res = await request(app)
      .post("/api/task-groups")
      .send({ name: "G", description: "d", input: "obj", tasks: [{ name: "S", description: "x", templateId: tpl.id }] });
    const groupId = res.body.id;

    await request(app).delete(`/api/task-templates/${tpl.id}`).expect(204);

    const tasks = await storage.getTasksByGroup(groupId);
    expect(tasks).toHaveLength(1);
    // template_id soft-cleared (onDelete: set null) but the definition survives intact.
    expect(tasks[0].templateId).toBeNull();
    expect(tasks[0].modelSlug).toBe("claude-opus");
    // Group still runnable: starting it creates iteration 1 over the copied definition.
    const start = await request(app).post(`/api/task-groups/${groupId}/start`);
    expect(start.status).toBe(200);
    expect(start.body.iteration.iterationNumber).toBe(1);
  });

  it("403 when composing a template the caller cannot see (cross-owner, create)", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const tpl = await seedTemplate(storage, "other-owner");
    const res = await request(app)
      .post("/api/task-groups")
      .send({ name: "G", description: "d", input: "obj", tasks: [{ name: "S", description: "x", templateId: tpl.id }] });
    expect(res.status).toBe(403);
  });

  it("404 when composing a non-existent template (create)", async () => {
    const { app } = createTaskGroupTestApp({ userId: "me" });
    const res = await request(app)
      .post("/api/task-groups")
      .send({ name: "G", description: "d", input: "obj", tasks: [{ name: "S", description: "x", templateId: "ghost" }] });
    expect(res.status).toBe(404);
  });
});

describe("compose copy-in — POST /api/task-groups/:id/tasks (add-from-template)", () => {
  async function seedOwnedGroup(storage: MemStorage) {
    const group = await storage.createTaskGroup({
      name: "G",
      description: "d",
      input: "obj",
      status: "pending",
      createdBy: "me",
    });
    return group;
  }

  it("add-from-template copies fields + labels + stamps template_id", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const group = await seedOwnedGroup(storage);
    const tpl = await seedTemplate(storage, "me");

    const res = await request(app)
      .post(`/api/task-groups/${group.id}/tasks`)
      .send({ name: "Added", description: "desc", templateId: tpl.id });
    expect(res.status).toBe(201);
    expect(res.body.templateId).toBe(tpl.id);
    expect(res.body.modelSlug).toBe("claude-opus");
    expect(res.body.labels).toEqual(["research", "draft"]);
    expect(res.body.teamId).toBe("team-x");
  });

  it("403 when adding from a cross-owner template", async () => {
    const { app, storage } = createTaskGroupTestApp({ userId: "me" });
    const group = await seedOwnedGroup(storage);
    const tpl = await seedTemplate(storage, "other-owner");
    const res = await request(app)
      .post(`/api/task-groups/${group.id}/tasks`)
      .send({ name: "Added", description: "desc", templateId: tpl.id });
    expect(res.status).toBe(403);
  });
});
