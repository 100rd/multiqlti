import { Router } from "express";
import { z } from "zod";
import { AnonymizerService } from "../privacy/anonymizer";
import { db } from "../db";
import {
  anonymizationLog,
  anonymizationPatterns,
  insertAnonymizationPatternSchema,
} from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import type { AnonymizationLevel } from "@shared/types";

const anonymizer = new AnonymizerService();

const testSchema = z.object({
  text: z.string().min(1),
  level: z.enum(["off", "standard", "strict"]),
});

const createPatternSchema = insertAnonymizationPatternSchema.extend({
  name: z.string().min(1).max(100),
  regexPattern: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]).default("high"),
  entityType: z.string().default("custom_pattern"),
  pseudonymTemplate: z.string().optional(),
  allowlist: z.array(z.string()).default([]),
});

export function registerPrivacyRoutes(router: Router): void {
  // POST /api/privacy/test — preview anonymization
  router.post("/api/privacy/test", (req, res) => {
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { text, level } = parsed.data;

    if (level === "off") {
      return res.json({ anonymized: text, entities: [] });
    }

    const sessionId = crypto.randomUUID();
    const result = anonymizer.anonymize(text, sessionId, level as AnonymizationLevel);
    anonymizer.clearSession(sessionId);

    return res.json({
      anonymized: result.anonymizedText,
      entities: result.entitiesFound.map((e) => ({
        type: e.type,
        severity: e.severity,
        confidence: e.confidence,
        length: e.end - e.start,
        // Never return the real value — return a masked preview
        preview: `[${e.type}]`,
      })),
    });
  });

  // GET /api/privacy/patterns — list custom patterns
  router.get("/api/privacy/patterns", async (_req, res) => {
    try {
      if (!process.env.DATABASE_URL) {
        return res.json([]);
      }
      const patterns = await db
        .select()
        .from(anonymizationPatterns)
        .orderBy(desc(anonymizationPatterns.createdAt));
      return res.json(patterns);
    } catch (err) {
      return res.status(500).json({ error: "Failed to fetch patterns" });
    }
  });

  // POST /api/privacy/patterns — create custom pattern
  router.post("/api/privacy/patterns", async (req, res) => {
    const parsed = createPatternSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    // Validate that the regex compiles
    try {
      new RegExp(parsed.data.regexPattern);
    } catch {
      return res.status(400).json({ error: "Invalid regular expression" });
    }

    if (!process.env.DATABASE_URL) {
      return res.status(503).json({ error: "Database not available" });
    }

    try {
      const [created] = await db
        .insert(anonymizationPatterns)
        .values({
          name: parsed.data.name,
          entityType: parsed.data.entityType,
          regexPattern: parsed.data.regexPattern,
          severity: parsed.data.severity,
          pseudonymTemplate: parsed.data.pseudonymTemplate ?? null,
          allowlist: parsed.data.allowlist,
        })
        .returning();
      return res.status(201).json(created);
    } catch (err) {
      return res.status(500).json({ error: "Failed to create pattern" });
    }
  });

  // DELETE /api/privacy/patterns/:id — delete pattern
  router.delete("/api/privacy/patterns/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid pattern ID" });
    }

    if (!process.env.DATABASE_URL) {
      return res.status(503).json({ error: "Database not available" });
    }

    try {
      await db
        .delete(anonymizationPatterns)
        .where(eq(anonymizationPatterns.id, id));
      return res.status(204).send();
    } catch (err) {
      return res.status(500).json({ error: "Failed to delete pattern" });
    }
  });

  // GET /api/privacy/audit-log — query audit log (optionally filter by runId)
  router.get("/api/privacy/audit-log", async (req, res) => {
    if (!process.env.DATABASE_URL) {
      return res.json([]);
    }

    try {
      const query = db
        .select()
        .from(anonymizationLog)
        .orderBy(desc(anonymizationLog.createdAt))
        .limit(100);

      const rows = await query;

      const runId = req.query.runId as string | undefined;
      const filtered = runId
        ? rows.filter((r) => r.runId === runId)
        : rows;

      return res.json(filtered);
    } catch (err) {
      return res.status(500).json({ error: "Failed to fetch audit log" });
    }
  });
}
