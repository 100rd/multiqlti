import { Router } from "express";
import { z } from "zod";
import { eq, desc, ilike, sql, and } from "drizzle-orm";
import { db } from "../db";
import { libraryChannels, libraryItems, LIBRARY_CHANNEL_TYPES } from "@shared/schema";
import { fetchRSSFeed } from "../services/rss-fetcher";

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createChannelSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(LIBRARY_CHANNEL_TYPES),
  url: z.string().url().optional().nullable(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  pollIntervalMinutes: z.number().int().min(5).max(1440).optional(),
});

const createItemSchema = z.object({
  title: z.string().min(1).max(500),
  url: z.string().url().optional().nullable(),
  contentText: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  author: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  sourceType: z.string().optional(),
  channelId: z.string().optional().nullable(),
});

// ─── Route Registration ─────────────────────────────────────────────────────

export function registerLibraryRoutes(app: Router): void {
  // ── Channels ────────────────────────────────────────────────────────────────

  app.get("/api/library/channels", async (_req, res) => {
    try {
      const channels = await db
        .select()
        .from(libraryChannels)
        .orderBy(desc(libraryChannels.createdAt));
      return res.json(channels);
    } catch {
      return res.status(500).json({ error: "Failed to fetch channels" });
    }
  });

  app.post("/api/library/channels", async (req, res) => {
    const parsed = createChannelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const [channel] = await db
        .insert(libraryChannels)
        .values({
          ...parsed.data,
          config: parsed.data.config ?? {},
          createdBy: (req as unknown as { user?: { id: string } }).user?.id ?? null,
        })
        .returning();
      return res.status(201).json(channel);
    } catch {
      return res.status(500).json({ error: "Failed to create channel" });
    }
  });

  app.put("/api/library/channels/:id", async (req, res) => {
    const parsed = createChannelSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const [updated] = await db
        .update(libraryChannels)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(libraryChannels.id, req.params.id))
        .returning();
      if (!updated) return res.status(404).json({ error: "Channel not found" });
      return res.json(updated);
    } catch {
      return res.status(500).json({ error: "Failed to update channel" });
    }
  });

  app.delete("/api/library/channels/:id", async (req, res) => {
    try {
      await db.delete(libraryChannels).where(eq(libraryChannels.id, req.params.id));
      return res.status(204).send();
    } catch {
      return res.status(500).json({ error: "Failed to delete channel" });
    }
  });

  // Manual poll a specific channel
  app.post("/api/library/channels/:id/poll", async (req, res) => {
    try {
      const [channel] = await db
        .select()
        .from(libraryChannels)
        .where(eq(libraryChannels.id, req.params.id));
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.type !== "rss" || !channel.url) {
        return res.status(400).json({ error: "Only RSS channels with a URL can be polled" });
      }

      const feedItems = await fetchRSSFeed(channel.url);
      let inserted = 0;

      for (const item of feedItems) {
        if (!item.link) continue;

        // Skip if already exists (de-dup by external_id = URL)
        const existing = await db
          .select({ id: libraryItems.id })
          .from(libraryItems)
          .where(eq(libraryItems.externalId, item.link))
          .limit(1);
        if (existing.length > 0) continue;

        await db.insert(libraryItems).values({
          channelId: channel.id,
          title: item.title || "Untitled",
          url: item.link,
          contentText: item.description || null,
          summary: item.description?.slice(0, 300) || null,
          author: item.author || null,
          tags: [],
          sourceType: "rss",
          externalId: item.link,
          publishedAt: item.pubDate ? new Date(item.pubDate) : null,
        });
        inserted++;
      }

      // Update channel poll timestamp
      await db
        .update(libraryChannels)
        .set({ lastPolledAt: new Date(), errorMessage: null, updatedAt: new Date() })
        .where(eq(libraryChannels.id, channel.id));

      return res.json({ fetched: feedItems.length, inserted });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      // Store error on the channel
      await db
        .update(libraryChannels)
        .set({ errorMessage: msg, updatedAt: new Date() })
        .where(eq(libraryChannels.id, req.params.id))
        .catch(() => {});
      return res.status(500).json({ error: `Poll failed: ${msg}` });
    }
  });

  // ── Items ──────────────────────────────────────────────────────────────────

  app.get("/api/library/items", async (req, res) => {
    try {
      const { q, tag, channelId, limit: limitStr, offset: offsetStr } = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(limitStr || "50", 10), 200);
      const offset = parseInt(offsetStr || "0", 10);

      const conditions = [];
      if (q) conditions.push(ilike(libraryItems.title, `%${q}%`));
      if (channelId) conditions.push(eq(libraryItems.channelId, channelId));
      if (tag) conditions.push(sql`${libraryItems.tags} @> ${JSON.stringify([tag])}::jsonb`);

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const items = await db
        .select()
        .from(libraryItems)
        .where(where)
        .orderBy(desc(libraryItems.publishedAt), desc(libraryItems.createdAt))
        .limit(limit)
        .offset(offset);

      return res.json(items);
    } catch {
      return res.status(500).json({ error: "Failed to fetch items" });
    }
  });

  app.post("/api/library/items", async (req, res) => {
    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const [item] = await db
        .insert(libraryItems)
        .values({
          ...parsed.data,
          tags: parsed.data.tags ?? [],
          sourceType: parsed.data.sourceType ?? "manual",
          externalId: parsed.data.url ?? null,
          createdBy: (req as unknown as { user?: { id: string } }).user?.id ?? null,
        })
        .returning();
      return res.status(201).json(item);
    } catch {
      return res.status(500).json({ error: "Failed to create item" });
    }
  });

  app.delete("/api/library/items/:id", async (req, res) => {
    try {
      await db.delete(libraryItems).where(eq(libraryItems.id, req.params.id));
      return res.status(204).send();
    } catch {
      return res.status(500).json({ error: "Failed to delete item" });
    }
  });
}
