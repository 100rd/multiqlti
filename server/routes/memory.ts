import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { MemoryScope, MemoryType } from "@shared/types";

const MEMORY_SCOPES = ["global", "workspace", "pipeline", "run"] as const;
const MEMORY_TYPES = ["decision", "pattern", "fact", "preference", "issue", "dependency"] as const;

const memoryBodySchema = z.object({
  scope: z.enum(MEMORY_SCOPES),
  scopeId: z.string().nullable().optional(),
  type: z.enum(MEMORY_TYPES),
  key: z.string().min(1).max(255),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().nullable().optional(),
});

const memoryUpdateSchema = z.object({
  content: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export function registerMemoryRoutes(app: Router, storage: IStorage): void {
  // GET /api/memories — list all memories with optional filters
  app.get("/api/memories", async (req, res) => {
    try {
      const { scope, type, q } = req.query as Record<string, string | undefined>;

      if (q) {
        const results = await storage.searchMemories(q, scope as MemoryScope | undefined);
        return res.json(results);
      }

      if (scope) {
        const results = await storage.getMemories(
          scope as MemoryScope,
          undefined,
          type as MemoryType | undefined,
        );
        return res.json(results);
      }

      // Return all — fetch global + pipeline scopes
      const [globalMems, pipelineMems, workspaceMems, runMems] = await Promise.all([
        storage.getMemories("global"),
        storage.getMemories("pipeline"),
        storage.getMemories("workspace"),
        storage.getMemories("run"),
      ]);

      const all = [...globalMems, ...pipelineMems, ...workspaceMems, ...runMems];
      const filtered = type ? all.filter((m) => m.type === type) : all;
      return res.json(filtered);
    } catch {
      return res.status(500).json({ error: "Failed to fetch memories" });
    }
  });

  // GET /api/pipelines/:id/memories — memories for a specific pipeline
  app.get("/api/pipelines/:id/memories", async (req, res) => {
    try {
      const results = await storage.getMemories("pipeline", req.params.id);
      return res.json(results);
    } catch {
      return res.status(500).json({ error: "Failed to fetch pipeline memories" });
    }
  });

  // POST /api/memories — create / upsert memory
  app.post("/api/memories", async (req, res) => {
    const parsed = memoryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    try {
      const memory = await storage.upsertMemory(parsed.data);
      return res.status(201).json(memory);
    } catch {
      return res.status(500).json({ error: "Failed to upsert memory" });
    }
  });

  // PUT /api/memories/:id — update content/confidence
  app.put("/api/memories/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid memory ID" });
    }

    const parsed = memoryUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    if (!parsed.data.content && parsed.data.confidence === undefined) {
      return res.status(400).json({ error: "Provide content or confidence to update" });
    }

    try {
      // Fetch existing to build upsert payload
      const [existing] = await storage.searchMemories("", undefined).then((all) =>
        all.filter((m) => m.id === id),
      );

      if (!existing) {
        return res.status(404).json({ error: "Memory not found" });
      }

      const updated = await storage.upsertMemory({
        scope: existing.scope,
        scopeId: existing.scopeId,
        type: existing.type,
        key: existing.key,
        content: parsed.data.content ?? existing.content,
        confidence: parsed.data.confidence ?? existing.confidence,
        source: existing.source,
        tags: existing.tags ?? [],
        createdByRunId: existing.createdByRunId ?? undefined,
      });

      return res.json(updated);
    } catch {
      return res.status(500).json({ error: "Failed to update memory" });
    }
  });

  // DELETE /api/memories/stale — delete memories with confidence < 0.3
  app.delete("/api/memories/stale", async (_req, res) => {
    try {
      const deleted = await storage.deleteStaleMemories(0.3);
      return res.json({ deleted });
    } catch {
      return res.status(500).json({ error: "Failed to delete stale memories" });
    }
  });

  // DELETE /api/memories/:id — delete a specific memory
  app.delete("/api/memories/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid memory ID" });
    }

    try {
      await storage.deleteMemory(id);
      return res.status(204).send();
    } catch {
      return res.status(500).json({ error: "Failed to delete memory" });
    }
  });
}
