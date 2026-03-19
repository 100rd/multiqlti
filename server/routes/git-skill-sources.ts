/**
 * git-skill-sources.ts — REST routes for managing remote git skill sources.
 *
 * All routes require authentication (enforced by middleware in routes.ts).
 * Mutating routes (POST create/delete/sync/pat) require admin role.
 *
 * Security:
 * - PAT is stored encrypted with AES-256-GCM, never returned in API responses
 * - URL validation rejects non-https/non-git@ schemes
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { eq, sql as drizzleSql, and } from "drizzle-orm";
import { db } from "../db";
import { gitSkillSources, skills } from "@shared/schema";
import type { GitSkillSourceRow } from "@shared/schema";
import { encrypt } from "../crypto";
import { isAllowedRepoUrl, syncGitSkillSource } from "../services/git-skill-sync";
import type { GitSkillSourceWithStats } from "@shared/types";

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const CreateGitSourceSchema = z.object({
  name: z.string().min(1, "Name is required").max(200, "Name too long"),
  repoUrl: z.string().min(1, "Repo URL is required").max(500, "URL too long"),
  branch: z.string().min(1, "Branch is required").max(200, "Branch too long").default("main"),
  path: z
    .string()
    .max(500, "Path too long")
    .default("/")
    .refine((p) => !p.includes(".."), { message: "Path must not contain .." }),
  syncOnStart: z.boolean().default(false),
});

const PatchGitSourceSchema = CreateGitSourceSchema.partial();

const PatSchema = z.object({
  pat: z.string().min(1, "PAT is required").max(500, "PAT too long"),
});

// ─── Helper: require admin ────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response): boolean {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Forbidden — admin role required" });
    return false;
  }
  return true;
}

// ─── Helper: attach skill counts ─────────────────────────────────────────────

async function attachStats(
  rows: GitSkillSourceRow[],
): Promise<GitSkillSourceWithStats[]> {
  if (rows.length === 0) return [];

  const counts = await db
    .select({
      gitSourceId: skills.gitSourceId,
      count: drizzleSql<number>`count(*)::int`,
    })
    .from(skills)
    .where(drizzleSql`${skills.gitSourceId} IS NOT NULL`)
    .groupBy(skills.gitSourceId);

  const countMap = new Map<string, number>();
  for (const c of counts) {
    if (c.gitSourceId) countMap.set(c.gitSourceId, c.count);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    repoUrl: r.repoUrl,
    branch: r.branch,
    path: r.path,
    syncOnStart: r.syncOnStart,
    lastSyncedAt: r.lastSyncedAt,
    lastError: r.lastError,
    createdAt: r.createdAt,
    skillCount: countMap.get(r.id) ?? 0,
    // encryptedPat is intentionally NOT included in responses
  }));
}

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerGitSkillSourceRoutes(app: Express): void {
  // ─── LIST all sources ──────────────────────────────────────────────────────

  app.get("/api/skills/git-sources", async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    try {
      const rows = await db
        .select()
        .from(gitSkillSources)
        .orderBy(gitSkillSources.createdAt);
      const result = await attachStats(rows);
      res.json(result);
    } catch (err) {
      console.error("[git-skill-sources] GET error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── CREATE source + trigger first sync ───────────────────────────────────

  app.post("/api/skills/git-sources", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const parsed = CreateGitSourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }

    const { name, repoUrl, branch, path, syncOnStart } = parsed.data;

    // URL scheme check
    if (!isAllowedRepoUrl(repoUrl)) {
      return res.status(400).json({
        error: "Invalid repo URL — only https:// and git@host:owner/repo.git are allowed",
      });
    }

    try {
      const [source] = await db
        .insert(gitSkillSources)
        .values({
          name,
          repoUrl,
          branch,
          path,
          syncOnStart,
          createdBy: req.user!.id,
        })
        .returning();

      // Trigger first sync asynchronously — don't block the response
      syncGitSkillSource(source.id).catch((err) => {
        console.error(`[git-skill-sources] Initial sync failed for ${source.id}:`, err);
      });

      const { encryptedPat: _pat, ...safeSource } = source;
      res.status(201).json({
        ...safeSource,
        skillCount: 0,
      });
    } catch (err) {
      console.error("[git-skill-sources] POST error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── DELETE source + its imported skills ──────────────────────────────────

  app.delete("/api/skills/git-sources/:id", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const sourceId = req.params.id as string;

    try {
      const [source] = await db
        .select()
        .from(gitSkillSources)
        .where(eq(gitSkillSources.id, sourceId));

      if (!source) {
        return res.status(404).json({ error: "Git source not found" });
      }

      // Delete imported skills first (gitSourceId FK → set null would leave orphans with sourceType=git)
      await db.delete(skills).where(eq(skills.gitSourceId, sourceId));

      // Delete the source
      await db.delete(gitSkillSources).where(eq(gitSkillSources.id, sourceId));

      res.status(204).end();
    } catch (err) {
      console.error("[git-skill-sources] DELETE error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── SYNC — manual re-sync (async, returns 202) ───────────────────────────

  app.post("/api/skills/git-sources/:id/sync", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const sourceId = req.params.id as string;

    try {
      const [source] = await db
        .select({ id: gitSkillSources.id })
        .from(gitSkillSources)
        .where(eq(gitSkillSources.id, sourceId));

      if (!source) {
        return res.status(404).json({ error: "Git source not found" });
      }

      // Fire and forget — caller polls GET /api/skills/git-sources for status
      syncGitSkillSource(sourceId).catch((err) => {
        console.error(`[git-skill-sources] Manual sync failed for ${sourceId}:`, err);
      });

      res.status(202).json({ message: "Sync started" });
    } catch (err) {
      console.error("[git-skill-sources] SYNC error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ─── PAT — store/update encrypted PAT for private repos ──────────────────

  app.post("/api/skills/git-sources/:id/pat", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    const sourceId = req.params.id as string;
    const parsed = PatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }

    try {
      const [source] = await db
        .select({ id: gitSkillSources.id })
        .from(gitSkillSources)
        .where(eq(gitSkillSources.id, sourceId));

      if (!source) {
        return res.status(404).json({ error: "Git source not found" });
      }

      const encryptedPat = encrypt(parsed.data.pat);

      await db
        .update(gitSkillSources)
        .set({ encryptedPat })
        .where(eq(gitSkillSources.id, sourceId));

      // PAT is never echoed back in the response
      res.status(204).end();
    } catch (err) {
      console.error("[git-skill-sources] PAT error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}
