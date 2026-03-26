/**
 * Federation Routes -- issues #224 + #225 + #226
 *
 * Session Sharing (issue #224):
 *   POST   /api/federation/sessions/share      -- share a run
 *   GET    /api/federation/sessions             -- list active sessions
 *   GET    /api/federation/sessions/:id         -- get session details
 *   DELETE /api/federation/sessions/:id         -- stop sharing
 *   POST   /api/federation/sessions/subscribe   -- subscribe to remote session
 *   GET    /api/federation/peers                -- list federation peers
 *
 * Memory Federation (issue #225):
 *   GET    /api/federation/memories/search      -- federated memory search
 *   PATCH  /api/memories/:id/publish            -- toggle published flag
 *
 * Pipeline Sync (issue #225):
 *   POST   /api/federation/pipelines/:id/export -- export pipeline as JSON
 *   POST   /api/federation/pipelines/import     -- import from JSON
 *   POST   /api/federation/pipelines/:id/offer  -- broadcast to peers
 *   GET    /api/federation/pipelines/offers      -- list received offers
 *   POST   /api/federation/pipelines/offers/:offerId/accept -- accept offer
 *
 * Async Handoff + Presence (issue #226):
 *   POST   /api/federation/sessions/:id/handoff   -- send handoff to peer
 *   POST   /api/federation/sessions/handoff/accept -- accept incoming handoff
 *   GET    /api/federation/sessions/handoffs       -- list pending handoffs
 *   GET    /api/federation/sessions/:id/presence   -- get session presence
 *   POST   /api/federation/sessions/:id/presence   -- record presence heartbeat
 *
 * All routes require authentication (covered by upstream requireAuth middleware).
 * Returns 503 when federation is not enabled.
 */
import type { Router, Request, Response } from "express";
import { z } from "zod";
import type { SessionSharingService } from "../federation/session-sharing";
import type { MemoryFederationService, FederatedMemoryResult } from "../federation/memory-federation";
import type { PipelineSyncService } from "../federation/pipeline-sync";
import type { FederationManager } from "../federation/index";
import type { IStorage } from "../storage";

// ─── Validation schemas ───────────────────────────────────────────────────────

const ShareRunSchema = z.object({
  runId: z.string().min(1),
  expiresIn: z.number().int().positive().optional(),
});

const SubscribeSchema = z.object({
  shareToken: z.string().min(1),
});

const MemorySearchSchema = z.object({
  q: z.string().min(1).max(1000),
  timeout: z.coerce.number().int().min(100).max(30000).optional(),
});

const PublishToggleSchema = z.object({
  published: z.boolean(),
});

const PipelineImportSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable(),
  stages: z.array(z.unknown()).min(1),
  exportedFrom: z.string().min(1),
  exportedAt: z.string().min(1),
});

const HandoffSchema = z.object({
  targetPeerId: z.string().min(1),
  notes: z.string().min(1).max(2000),
});

const HandoffAcceptSchema = z.object({
  bundleToken: z.string().min(1),
});


// ─── Route registration ───────────────────────────────────────────────────────

export function registerFederationRoutes(
  app: Router,
  sessionSharing: SessionSharingService | null,
  federationManager: FederationManager | null,
  memoryFederation?: MemoryFederationService | null,
  pipelineSync?: PipelineSyncService | null,
  storage?: IStorage | null,
): void {
  const federationDisabledResponse = (res: Response) =>
    res.status(503).json({
      error: "Federation is not enabled on this instance",
      disabled: true,
    });

  // ─── Session Sharing (issue #224) ─────────────────────────────────────────

  // POST /api/federation/sessions/share -- share a run
  app.post("/api/federation/sessions/share", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    const parsed = ShareRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const userId = (req as unknown as { user?: { id?: string } }).user?.id ?? "anonymous";
      const session = await sessionSharing.shareRun(
        parsed.data.runId,
        userId,
        parsed.data.expiresIn,
      );
      return res.status(201).json(session);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/federation/sessions/handoffs -- list pending incoming handoffs (issue #226)
  // NOTE: this must come before the :id wildcard route
  app.get("/api/federation/sessions/handoffs", (_req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);
    return res.json(sessionSharing.getPendingHandoffs());
  });

  // GET /api/federation/sessions -- list active sessions
  app.get("/api/federation/sessions", async (_req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    try {
      const sessions = await sessionSharing.getActiveSessions();
      return res.json(sessions);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/federation/sessions/:id -- get session details
  app.get("/api/federation/sessions/:id", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    try {
      const sessions = await sessionSharing.getActiveSessions();
      const session = sessions.find((s) => s.id === String(req.params.id));
      if (!session) return res.status(404).json({ error: "Session not found" });
      return res.json(session);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/federation/sessions/:id/presence -- get session presence (issue #226)
  app.get("/api/federation/sessions/:id/presence", (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);
    const entries = sessionSharing.getSessionPresence(String(req.params.id));
    return res.json(entries);
  });

  // DELETE /api/federation/sessions/:id -- stop sharing
  app.delete("/api/federation/sessions/:id", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    try {
      await sessionSharing.stopSharing(String(req.params.id));
      return res.status(204).send();
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/federation/sessions/subscribe -- subscribe to remote session
  app.post("/api/federation/sessions/subscribe", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      sessionSharing.subscribeToSession(parsed.data.shareToken);
      return res.status(200).json({ subscribed: true, shareToken: parsed.data.shareToken });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Async Handoff (issue #226) ────────────────────────────────────────────

  // POST /api/federation/sessions/:id/handoff -- send handoff to peer
  app.post("/api/federation/sessions/:id/handoff", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    const parsed = HandoffSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const bundleToken = await sessionSharing.sendHandoff(
        String(req.params.id),
        parsed.data.targetPeerId,
        parsed.data.notes,
      );
      return res.status(200).json({ bundleToken });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/federation/sessions/handoff/accept -- accept incoming handoff
  app.post("/api/federation/sessions/handoff/accept", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    const parsed = HandoffAcceptSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const result = await sessionSharing.acceptHandoff(parsed.data.bundleToken);
      return res.status(201).json(result);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/federation/sessions/:id/presence -- record presence heartbeat
  app.post("/api/federation/sessions/:id/presence", (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    const user = (req as unknown as { user?: { id?: string } }).user;
    if (!user?.id) {
      return res.status(401).json({ error: "Authenticated user required" });
    }

    sessionSharing.recordPresence(String(req.params.id), user.id);
    return res.status(200).json({ ok: true });
  });

  // GET /api/federation/peers -- list federation peers
  app.get("/api/federation/peers", (_req: Request, res: Response) => {
    if (!federationManager) return federationDisabledResponse(res);

    const peers = federationManager.getPeers();
    return res.json(peers);
  });

  // ─── Memory Federation (issue #225) ───────────────────────────────────────

  // GET /api/federation/memories/search -- federated memory search
  app.get("/api/federation/memories/search", async (req: Request, res: Response) => {
    if (!memoryFederation || !storage) return federationDisabledResponse(res);

    const parsed = MemorySearchSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query parameters", issues: parsed.error.flatten() });
    }

    try {
      const localMatches = await storage.searchMemories(parsed.data.q);
      const publishedLocal = localMatches.filter((m) => m.published);
      const localResults: FederatedMemoryResult[] = publishedLocal.map((m) => ({
        id: String(m.id),
        content: m.content,
        tags: (m.tags ?? []) as string[],
        sourceInstance: "local",
        sourceInstanceName: "local",
        relevance: m.confidence,
      }));

      const result = await memoryFederation.federatedSearch(
        parsed.data.q,
        localResults,
        parsed.data.timeout,
      );

      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // PATCH /api/memories/:id/publish -- toggle published flag (admin/maintainer only)
  app.patch("/api/memories/:id/publish", async (req: Request, res: Response) => {
    if (!storage) {
      return res.status(503).json({ error: "Storage not available" });
    }

    const user = (req as unknown as { user?: { id?: string; role?: string } }).user;
    if (!user || (user.role !== "admin" && user.role !== "maintainer")) {
      return res.status(403).json({ error: "Only admin or maintainer can publish memories" });
    }

    const memoryId = Number(req.params.id);
    if (!Number.isFinite(memoryId) || memoryId < 1) {
      return res.status(400).json({ error: "Invalid memory ID" });
    }

    const parsed = PublishToggleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", issues: parsed.error.flatten() });
    }

    try {
      const updated = await storage.updateMemoryPublished(memoryId, parsed.data.published);
      if (!updated) {
        return res.status(404).json({ error: "Memory not found" });
      }
      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Pipeline Sync (issue #225) ───────────────────────────────────────────

  // POST /api/federation/pipelines/:id/export -- export pipeline as JSON
  app.post("/api/federation/pipelines/:id/export", async (req: Request, res: Response) => {
    if (!pipelineSync) return federationDisabledResponse(res);

    try {
      const exported = await pipelineSync.exportPipeline(String(req.params.id));
      return res.json(exported);
    } catch (err) {
      const message = (err as Error).message;
      if (message === "Pipeline not found") {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  // POST /api/federation/pipelines/import -- import from JSON
  app.post("/api/federation/pipelines/import", async (req: Request, res: Response) => {
    if (!pipelineSync) return federationDisabledResponse(res);

    const parsed = PipelineImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid pipeline data", issues: parsed.error.flatten() });
    }

    try {
      const newId = await pipelineSync.importPipeline(parsed.data);
      return res.status(201).json({ id: newId });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/federation/pipelines/:id/offer -- broadcast to peers
  app.post("/api/federation/pipelines/:id/offer", async (req: Request, res: Response) => {
    if (!pipelineSync) return federationDisabledResponse(res);

    try {
      const exported = await pipelineSync.exportPipeline(String(req.params.id));
      pipelineSync.offerPipeline(exported);
      return res.json({ offered: true, pipeline: exported });
    } catch (err) {
      const message = (err as Error).message;
      if (message === "Pipeline not found") {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  // GET /api/federation/pipelines/offers -- list received offers
  app.get("/api/federation/pipelines/offers", (_req: Request, res: Response) => {
    if (!pipelineSync) return federationDisabledResponse(res);

    const offers = pipelineSync.getReceivedOffers();
    return res.json(offers);
  });

  // POST /api/federation/pipelines/offers/:offerId/accept -- accept offer
  app.post("/api/federation/pipelines/offers/:offerId/accept", async (req: Request, res: Response) => {
    if (!pipelineSync) return federationDisabledResponse(res);

    try {
      const newId = await pipelineSync.acceptOffer(String(req.params.offerId));
      return res.status(201).json({ id: newId });
    } catch (err) {
      const message = (err as Error).message;
      if (message === "Offer not found or expired") {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });
}
