/**
 * Morning News Board API (Wave 2).
 *
 * Base: /api/workspaces/:id/news
 *
 * Auth mirrors practice-cards EXACTLY: every route resolves the workspace
 * (404 if missing) then gates with requireOwnerOrRole(() => ws.ownerId, ...).
 * The brief/profile/feedback surfaces are SELF-scoped — userId is bound to
 * req.user.id and is NEVER taken from the body; cross-workspace / cross-user
 * resources 404. Clients get generic errors; detail is logged server-side. We
 * never surface raw Omniscience error envelopes or the token.
 *
 * Generation is LAZY-on-first-GET (BriefScheduler.ensureBrief) with a per-day
 * lock + rate-limit (C1/M1). All collaborators are injected for testability.
 */
import type { Router, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage.js";
import { requireOwnerOrRole } from "../auth/middleware.js";
import { applyFeedback, type FeedbackAction } from "../news/news-service.js";
import { RateLimitError } from "../news/brief-scheduler.js";
import {
  NEWS_PROFILE_ROLES,
  NEWS_CATEGORIES,
  NEWS_READ_STATES,
  type MorningBriefRow,
  type NewsItemRow,
} from "@shared/schema";

const BASE = "/api/workspaces/:id/news";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Injected dependencies ───────────────────────────────────────────────────

export interface NewsScheduler {
  /** Lazy generate-on-miss (lock + cache + rate-limit). */
  ensureBrief: (p: { workspaceId: string; userId: string; briefDate: string }) => Promise<MorningBriefRow>;
  /** Manual refresh (rate-limited). Returns the briefId. */
  triggerNow: (p: { workspaceId: string; userId: string; briefDate: string }) => Promise<string>;
}

export interface NewsDeps {
  scheduler: NewsScheduler;
  /** Server clock (injectable for tests). */
  now?: () => Date;
}

// ─── Validation (strict; no passthrough) ─────────────────────────────────────

const profileBodySchema = z
  .object({
    role: z.enum(NEWS_PROFILE_ROLES),
    stack: z.array(z.string().min(1).max(120)).max(50),
    mutedCategories: z.array(z.string().min(1).max(120)).max(20).optional(),
  })
  .strict();

const briefQuerySchema = z
  .object({
    date: z.string().regex(DATE_RE).optional(),
    category: z.enum(NEWS_CATEGORIES).optional(),
    readState: z.enum(NEWS_READ_STATES).optional(),
  })
  .strict();

const briefsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(60).optional().default(14),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .strict();

const refreshBodySchema = z
  .object({ date: z.string().regex(DATE_RE).optional() })
  .strict();

const feedbackBodySchema = z
  .object({ action: z.enum(["read", "up", "down", "hidden"]) })
  .strict();

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ResolvedWorkspace {
  id: string;
  ownerId: string | null;
}

async function resolveWorkspace(storage: IStorage, req: Request, res: Response): Promise<ResolvedWorkspace | null> {
  const ws = await storage.getWorkspace(String(req.params.id));
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  return { id: ws.id, ownerId: ws.ownerId };
}

function requireUserId(req: Request, res: Response): string | null {
  const userId = req.user?.id;
  if (!userId) {
    res.status(403).json({ error: "Forbidden — authenticated identity required" });
    return null;
  }
  return userId;
}

function logServerError(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[news] ${context}: ${detail}`);
}

/** Server-side UTC day (YYYY-MM-DD). Client `date` is validated, never trusted raw. */
function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** M2 defense-in-depth: only expose https sourceUri links; null out anything else. */
function sanitizeItem(item: NewsItemRow): NewsItemRow {
  if (!item.sourceUri) return item;
  let ok = false;
  try {
    ok = new URL(item.sourceUri).protocol === "https:";
  } catch {
    ok = false;
  }
  return ok ? item : { ...item, sourceUri: null };
}

// ─── Route registration ──────────────────────────────────────────────────────

export function registerNewsRoutes(router: Router, storage: IStorage, deps: NewsDeps): void {
  const clock = deps.now ?? (() => new Date());

  registerProfileRoutes(router, storage, clock);
  registerBriefRoutes(router, storage, deps, clock);
  registerFeedbackRoute(router, storage);
}

function registerProfileRoutes(router: Router, storage: IStorage, _clock: () => Date): void {
  // GET /news/profile — auth + owner; own profile (creates default if absent).
  router.get(`${BASE}/profile`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      try {
        const existing = await storage.getNewsProfile(ws.id, userId);
        const profile = existing ?? (await storage.upsertNewsProfile({ workspaceId: ws.id, userId }));
        return res.status(200).json({ data: profile });
      } catch (err) {
        logServerError("get profile failed", err);
        return res.status(500).json({ error: "Failed to load profile" });
      }
    });
  });

  // PUT /news/profile — auth + owner; own profile.
  router.put(`${BASE}/profile`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      const parsed = profileBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      }
      try {
        const profile = await storage.upsertNewsProfile({
          workspaceId: ws.id,
          userId,
          role: parsed.data.role,
          stack: parsed.data.stack,
          mutedCategories: parsed.data.mutedCategories ?? [],
        });
        return res.status(200).json({ data: profile });
      } catch (err) {
        logServerError("put profile failed", err);
        return res.status(500).json({ error: "Failed to save profile" });
      }
    });
  });
}

function registerBriefRoutes(router: Router, storage: IStorage, deps: NewsDeps, clock: () => Date): void {
  // GET /news/brief — auth + owner; own brief; lazy-generate-on-miss.
  router.get(`${BASE}/brief`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      const parsed = briefQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      }
      const briefDate = parsed.data.date ?? todayUtc(clock());
      try {
        const brief = await deps.scheduler.ensureBrief({ workspaceId: ws.id, userId, briefDate });
        const items = await storage.listNewsItems(brief.id, {
          category: parsed.data.category,
          readState: parsed.data.readState,
        });
        return res.status(200).json({
          data: { brief, items: items.map(sanitizeItem) },
          meta: { internalDegraded: brief.internalDegraded },
        });
      } catch (err) {
        logServerError("get brief failed", err);
        return res.status(500).json({ error: "Failed to load brief" });
      }
    });
  });

  // GET /news/briefs — auth + owner; own history.
  router.get(`${BASE}/briefs`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      const parsed = briefsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      }
      try {
        const { briefs, total } = await storage.listMorningBriefs(ws.id, {
          userId,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
        });
        return res.status(200).json({ data: briefs, meta: { total } });
      } catch (err) {
        logServerError("list briefs failed", err);
        return res.status(500).json({ error: "Failed to list briefs" });
      }
    });
  });

  // POST /news/refresh — maintainer/admin/owner; rate-limited.
  router.post(`${BASE}/refresh`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      const parsed = refreshBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      }
      const briefDate = parsed.data.date ?? todayUtc(clock());
      try {
        const briefId = await deps.scheduler.triggerNow({ workspaceId: ws.id, userId, briefDate });
        return res.status(202).json({ data: { briefId } });
      } catch (err) {
        if (err instanceof RateLimitError) {
          return res.status(429).json({ error: "Daily refresh limit reached" });
        }
        logServerError("refresh failed", err);
        return res.status(500).json({ error: "Failed to start refresh" });
      }
    });
  });
}

function registerFeedbackRoute(router: Router, storage: IStorage): void {
  // POST /news/items/:itemId/feedback — auth + owner; own item only.
  router.post(`${BASE}/items/:itemId/feedback`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      const parsed = feedbackBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      }
      try {
        const item = await loadItemForUser(storage, String(req.params.itemId), ws.id, userId, res);
        if (!item) return;
        const next = applyFeedback(
          { readState: item.readState, feedback: item.feedback },
          parsed.data.action as FeedbackAction,
        );
        const updated = await storage.setNewsItemFeedback(item.id, next);
        return res.status(200).json({ data: sanitizeItem(updated) });
      } catch (err) {
        logServerError("feedback failed", err);
        return res.status(500).json({ error: "Failed to record feedback" });
      }
    });
  });
}

// ─── Internal ──────────────────────────────────────────────────────────────────

/** Load an item, 404 unless it belongs to this workspace AND the user's brief. */
async function loadItemForUser(
  storage: IStorage,
  itemId: string,
  workspaceId: string,
  userId: string,
  res: Response,
): Promise<NewsItemRow | null> {
  const item = await storage.getNewsItem(itemId);
  if (!item || item.workspaceId !== workspaceId) {
    res.status(404).json({ error: "News item not found" });
    return null;
  }
  const brief = await storage.getMorningBrief(item.briefId);
  if (!brief || brief.workspaceId !== workspaceId || brief.userId !== userId) {
    res.status(404).json({ error: "News item not found" });
    return null;
  }
  return item;
}
