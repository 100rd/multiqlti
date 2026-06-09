import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { MemStorage } from "../../server/storage.js";
import { registerLessonRoutes } from "../../server/routes/lessons.js";

function makeApp(storage: MemStorage) {
  const app = express();
  app.use(express.json());
  registerLessonRoutes(app, storage);
  return app;
}

describe("GET /api/lessons", () => {
  let storage: MemStorage;

  beforeEach(async () => {
    storage = new MemStorage();
    await storage.createLesson({
      workspaceId: "ws-1",
      outcome: "failure",
      title: "ws-1 lesson",
      summary: "boom",
    });
    await storage.createLesson({
      workspaceId: "ws-2",
      outcome: "success",
      title: "ws-2 lesson",
      summary: "ok",
    });
  });

  it("returns all lessons when no workspace filter is given", async () => {
    const res = await request(makeApp(storage)).get("/api/lessons");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("filters lessons by workspaceId", async () => {
    const res = await request(makeApp(storage)).get("/api/lessons?workspaceId=ws-1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe("ws-1 lesson");
  });
});
