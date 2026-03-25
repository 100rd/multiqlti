/**
 * Federation Session Sharing Routes — issue #224
 *
 * Endpoints:
 *   POST   /api/federation/sessions/share      — share a run
 *   GET    /api/federation/sessions             — list active sessions
 *   GET    /api/federation/sessions/:id         — get session details
 *   DELETE /api/federation/sessions/:id         — stop sharing
 *   POST   /api/federation/sessions/subscribe   — subscribe to remote session
 *   GET    /api/federation/peers                — list federation peers
 *
 * All routes require authentication (covered by upstream requireAuth middleware).
 * Returns 503 when federation is not enabled.
 */
import type { Router, Request, Response } from "express";
import { z } from "zod";
import type { SessionSharingService } from "../federation/session-sharing";
import type { FederationManager } from "../federation/index";

// ─── Validation schemas ───────────────────────────────────────────────────────

const ShareRunSchema = z.object({
  runId: z.string().min(1),
  expiresIn: z.number().int().positive().optional(),
});

const SubscribeSchema = z.object({
  shareToken: z.string().min(1),
});

// ─── Route registration ───────────────────────────────────────────────────────

export function registerFederationRoutes(
  app: Router,
  sessionSharing: SessionSharingService | null,
  federationManager: FederationManager | null,
): void {
  const federationDisabledResponse = (res: Response) =>
    res.status(503).json({
      error: "Federation is not enabled on this instance",
      disabled: true,
    });

  // POST /api/federation/sessions/share — share a run
  app.post("/api/federation/sessions/share", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    const parsed = ShareRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
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

  // GET /api/federation/sessions — list active sessions
  app.get("/api/federation/sessions", async (_req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    try {
      const sessions = await sessionSharing.getActiveSessions();
      return res.json(sessions);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/federation/sessions/:id — get session details
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

  // DELETE /api/federation/sessions/:id — stop sharing
  app.delete("/api/federation/sessions/:id", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    try {
      await sessionSharing.stopSharing(String(req.params.id));
      return res.status(204).send();
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/federation/sessions/subscribe — subscribe to remote session
  app.post("/api/federation/sessions/subscribe", async (req: Request, res: Response) => {
    if (!sessionSharing) return federationDisabledResponse(res);

    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    }

    try {
      sessionSharing.subscribeToSession(parsed.data.shareToken);
      return res.status(200).json({ subscribed: true, shareToken: parsed.data.shareToken });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/federation/peers — list federation peers
  app.get("/api/federation/peers", (_req: Request, res: Response) => {
    if (!federationManager) return federationDisabledResponse(res);

    const peers = federationManager.getPeers();
    return res.json(peers);
  });
}
