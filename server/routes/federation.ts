/**
 * Federation Routes -- issues #224 + #225 + #226 + #233 + #230
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
 * Cross-Instance Delegation (issue #233):
 *   POST   /api/federation/delegation/request     -- delegate a stage to peer
 *   GET    /api/federation/delegation/active       -- list active delegations
 *   GET    /api/federation/delegation/:id          -- get delegation status
 *   DELETE /api/federation/delegation/:id          -- cancel delegation
 *   GET    /api/federation/delegation/policy       -- get delegation policy
 *

 * CRDT P2P Collaboration (issue #230):
 *   GET    /api/sessions/:id/crdt-state       -- current CRDT document state
 *   POST   /api/sessions/:id/crdt-merge       -- receive remote CRDT state and merge
 *   GET    /api/sessions/:id/crdt-peers       -- list peers and their vector clock versions
 *   POST   /api/sessions/:id/crdt-mode        -- set sync mode (single_writer | crdt_p2p)
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
import type { CrossInstanceDelegationService } from "../federation/delegation";
import type { IStorage } from "../storage";
import type { ConflictResolutionService } from "../federation/conflict-resolution";
import type { CRDTPeerSyncService } from "../federation/crdt/peer-sync";

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

const DelegationRequestSchema = z.object({
  runId: z.string().min(1),
  stageIndex: z.number().int().min(0),
  targetPeerId: z.string().min(1),
  stage: z.object({
    teamId: z.string().min(1),
    modelSlug: z.string().min(1),
    enabled: z.boolean(),
    systemPromptOverride: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    approvalRequired: z.boolean().optional(),
  }).passthrough(),
  input: z.string(),
  variables: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
});

const VALID_STRATEGIES = [
  "structured_debate",
  "quorum_vote",
  "parallel_experiment",
  "defer_to_owner",
] as const;

const RaiseConflictSchema = z.object({
  question: z.string().min(1).max(2000),
  context: z.string().max(5000).optional(),
  strategy: z.enum(VALID_STRATEGIES),
  quorumThreshold: z.number().min(0.5).max(1.0).optional(),
  timeoutMs: z.number().int().min(5000).max(3_600_000).optional(),
});

const AddProposalSchema = z.object({
  authorId: z.string().min(1),
  instanceId: z.string().min(1),
  title: z.string().min(1).max(255),
  description: z.string().min(1).max(5000),
  arguments: z.string().max(5000).optional(),
});

const CastConflictVoteSchema = z.object({
  participantId: z.string().min(1),
  instanceId: z.string().min(1),
  proposalId: z.string().min(1),
  anonymous: z.boolean().optional(),
});

const ForceResolveSchema = z.object({
  winningProposalId: z.string().optional(),
  reasoning: z.string().min(1).max(2000),
  decidedBy: z.enum(["quorum", "judge", "owner", "timeout"]).optional(),
});

const UpdateExperimentBranchSchema = z.object({
  proposalId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["pending", "completed", "failed"]),
  outcome: z.string().max(5000).optional(),
});


// ─── Route registration ───────────────────────────────────────────────────────

export function registerFederationRoutes(
  app: Router,
  sessionSharing: SessionSharingService | null,
  federationManager: FederationManager | null,
  memoryFederation?: MemoryFederationService | null,
  pipelineSync?: PipelineSyncService | null,
  storage?: IStorage | null,
  crossDelegation?: CrossInstanceDelegationService | null,
  conflictResolution?: ConflictResolutionService | null,
  crdtPeerSync?: CRDTPeerSyncService | null,
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

  // ─── Cross-Instance Delegation (issue #233) ───────────────────────────────

  // POST /api/federation/delegation/request -- delegate a stage to a peer
  app.post("/api/federation/delegation/request", async (req: Request, res: Response) => {
    if (!crossDelegation) return federationDisabledResponse(res);

    const parsed = DelegationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const { runId, stageIndex, targetPeerId, stage, input, variables, timeoutMs } = parsed.data;
      const result = await crossDelegation.delegateAndWait(
        runId,
        stageIndex,
        targetPeerId,
        stage as import("@shared/types").PipelineStageConfig,
        input,
        variables,
        timeoutMs,
      );
      return res.status(200).json(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message.startsWith("Delegation denied:")) {
        return res.status(403).json({ error: message });
      }
      if (message.includes("max concurrent limit")) {
        return res.status(429).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  // GET /api/federation/delegation/active -- list active delegations
  app.get("/api/federation/delegation/active", (_req: Request, res: Response) => {
    if (!crossDelegation) return federationDisabledResponse(res);
    return res.json(crossDelegation.getActiveDelegations());
  });

  // GET /api/federation/delegation/policy -- get delegation policy
  app.get("/api/federation/delegation/policy", (_req: Request, res: Response) => {
    if (!crossDelegation) return federationDisabledResponse(res);
    return res.json(crossDelegation.getPolicy());
  });

  // GET /api/federation/delegation/:id -- get delegation status
  app.get("/api/federation/delegation/:id", (_req: Request, res: Response) => {
    if (!crossDelegation) return federationDisabledResponse(res);

    const delegationId = String(_req.params.id);
    const active = crossDelegation.getActiveDelegations();
    const found = active.find((d) => d.delegationId === delegationId);
    if (!found) {
      return res.status(404).json({ error: "Delegation not found or already completed" });
    }
    return res.json(found);
  });

  // DELETE /api/federation/delegation/:id -- cancel delegation
  app.delete("/api/federation/delegation/:id", (_req: Request, res: Response) => {
    if (!crossDelegation) return federationDisabledResponse(res);

    const delegationId = String(_req.params.id);
    const cancelled = crossDelegation.cancelDelegation(delegationId);
    if (!cancelled) {
      return res.status(404).json({ error: "Delegation not found or already completed" });
    }
    return res.status(200).json({ cancelled: true, delegationId });
  });

  // ─── Conflict Resolution (issue #229) ────────────────────────────────────────

  // POST /api/sessions/:id/conflicts -- raise a conflict
  app.post("/api/sessions/:id/conflicts", async (req: Request, res: Response) => {
    if (!conflictResolution) {
      return res.status(503).json({ error: "Conflict resolution service not available" });
    }

    const parsed = RaiseConflictSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    const user = (req as unknown as { user?: { id?: string } }).user;
    if (!user?.id) {
      return res.status(401).json({ error: "Authenticated user required" });
    }

    try {
      const { conflictId } = await conflictResolution.raiseConflict({
        sessionId: String(req.params.id),
        raisedBy: user.id,
        raisedByInstance: "local",
        question: parsed.data.question,
        context: parsed.data.context,
        strategy: parsed.data.strategy,
        quorumThreshold: parsed.data.quorumThreshold,
        timeoutMs: parsed.data.timeoutMs,
      });

      const conflict = conflictResolution.getConflict(conflictId);
      return res.status(201).json(conflict);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/sessions/:id/conflicts -- list conflicts for a session
  app.get("/api/sessions/:id/conflicts", (_req: Request, res: Response) => {
    if (!conflictResolution) {
      return res.status(503).json({ error: "Conflict resolution service not available" });
    }

    const conflicts = conflictResolution.getSessionConflicts(String(_req.params.id));
    return res.json(conflicts);
  });

  // POST /api/sessions/:id/conflicts/:cid/proposals -- add a proposal
  app.post("/api/sessions/:id/conflicts/:cid/proposals", async (req: Request, res: Response) => {
    if (!conflictResolution) {
      return res.status(503).json({ error: "Conflict resolution service not available" });
    }

    const parsed = AddProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const conflict = await conflictResolution.addProposal(
        String(req.params.cid),
        {
          authorId: parsed.data.authorId,
          instanceId: parsed.data.instanceId,
          title: parsed.data.title,
          description: parsed.data.description,
          arguments: parsed.data.arguments,
        },
      );
      return res.status(201).json(conflict);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("already resolved") || msg.includes("already expired")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  // POST /api/sessions/:id/conflicts/:cid/vote -- cast a vote
  app.post("/api/sessions/:id/conflicts/:cid/vote", async (req: Request, res: Response) => {
    if (!conflictResolution) {
      return res.status(503).json({ error: "Conflict resolution service not available" });
    }

    const parsed = CastConflictVoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const conflict = await conflictResolution.castVote(
        String(req.params.cid),
        {
          participantId: parsed.data.participantId,
          instanceId: parsed.data.instanceId,
          proposalId: parsed.data.proposalId,
          anonymous: parsed.data.anonymous,
        },
      );
      return res.json(conflict);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("already voted")) {
        return res.status(409).json({ error: msg });
      }
      if (msg.includes("not found")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  // POST /api/sessions/:id/conflicts/:cid/resolve -- force-resolve a conflict
  app.post("/api/sessions/:id/conflicts/:cid/resolve", async (req: Request, res: Response) => {
    if (!conflictResolution) {
      return res.status(503).json({ error: "Conflict resolution service not available" });
    }

    const parsed = ForceResolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const conflict = await conflictResolution.forceResolve(
        String(req.params.cid),
        parsed.data.winningProposalId,
        parsed.data.reasoning,
        parsed.data.decidedBy,
      );
      return res.json(conflict);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("already")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  // POST /api/sessions/:id/conflicts/:cid/judge -- run LLM debate judge
  app.post("/api/sessions/:id/conflicts/:cid/judge", async (req: Request, res: Response) => {
    if (!conflictResolution) {
      return res.status(503).json({ error: "Conflict resolution service not available" });
    }

    try {
      const judgement = await conflictResolution.runDebateJudge(String(req.params.cid));
      return res.json(judgement);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("already")) {
        return res.status(404).json({ error: msg });
      }
      if (msg.includes("No LLM gateway")) {
        return res.status(503).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  // POST /api/sessions/:id/conflicts/:cid/experiment -- update an experiment branch
  app.post("/api/sessions/:id/conflicts/:cid/experiment", async (req: Request, res: Response) => {
    if (!conflictResolution) {
      return res.status(503).json({ error: "Conflict resolution service not available" });
    }

    const parsed = UpdateExperimentBranchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const conflict = await conflictResolution.updateExperimentBranch(
        String(req.params.cid),
        {
          proposalId: parsed.data.proposalId,
          runId: parsed.data.runId,
          status: parsed.data.status,
          outcome: parsed.data.outcome,
          completedAt: parsed.data.status !== "pending" ? Date.now() : undefined,
        },
      );
      return res.json(conflict);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("already")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  // GET /api/sessions/:id/decision-log -- get decision log for a session
  app.get("/api/sessions/:id/decision-log", (_req: Request, res: Response) => {
    if (!conflictResolution) {
      return res.status(503).json({ error: "Conflict resolution service not available" });
    }

    const log = conflictResolution.getSessionDecisionLog(String(_req.params.id));
    return res.json(log);
  });
}

// ─── CRDT P2P Collaboration Routes (issue #230) ───────────────────────────────

// Validation schema for mode changes
const SetCRDTModeSchema = z.object({
  mode: z.enum(["single_writer", "crdt_p2p"]),
});

// Validation schema for merging incoming CRDT state
const CRDTMergeSchema = z.object({
  state: z.object({
    sessionId: z.string().min(1),
    nodeId: z.string().min(1),
    participants: z.object({
      type: z.literal("or-set"),
      entries: z.record(z.array(z.string())),
      tombstones: z.array(z.string()),
    }),
    stageOutputs: z.object({
      type: z.literal("lww-map"),
      entries: z.record(z.unknown()),
    }),
    stageStatuses: z.object({
      type: z.literal("lww-map"),
      entries: z.record(z.unknown()),
    }),
    votes: z.object({
      type: z.literal("g-counter"),
      counters: z.record(z.number()),
    }),
    tags: z.object({
      type: z.literal("or-set"),
      entries: z.record(z.array(z.string())),
      tombstones: z.array(z.string()),
    }),
    metadata: z.object({
      type: z.literal("lww-register"),
      value: z.unknown(),
      timestamp: z.number(),
      nodeId: z.string(),
    }),
    vectorClock: z.object({
      clocks: z.record(z.number()),
    }),
  }),
});

export function registerCRDTRoutes(
  app: Router,
  crdtPeerSync: CRDTPeerSyncService | null,
): void {
  const notAvailable = (res: Response) =>
    res.status(503).json({ error: "CRDT peer sync service not available" });

  // GET /api/sessions/:id/crdt-state — current CRDT document state
  app.get("/api/sessions/:id/crdt-state", (req: Request, res: Response) => {
    if (!crdtPeerSync) return notAvailable(res);

    const sessionId = String(req.params.id);
    const mode = crdtPeerSync.getSyncMode(sessionId);

    if (mode !== "crdt_p2p") {
      return res.json({
        sessionId,
        syncMode: mode,
        state: null,
        value: null,
      });
    }

    const doc = crdtPeerSync.getOrCreateDocument(sessionId);
    if (!doc) return notAvailable(res);

    return res.json({
      sessionId,
      syncMode: mode,
      state: doc.toState(),
      value: doc.snapshot(),
    });
  });

  // POST /api/sessions/:id/crdt-merge — receive remote CRDT state and merge
  app.post("/api/sessions/:id/crdt-merge", (req: Request, res: Response) => {
    if (!crdtPeerSync) return notAvailable(res);

    const sessionId = String(req.params.id);
    const parsed = CRDTMergeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid CRDT state", issues: parsed.error.flatten() });
    }

    const mode = crdtPeerSync.getSyncMode(sessionId);
    if (mode !== "crdt_p2p") {
      return res.status(409).json({
        error: "Session is in single_writer mode; CRDT merge not applicable",
        syncMode: mode,
      });
    }

    const doc = crdtPeerSync.getOrCreateDocument(sessionId);
    if (!doc) return notAvailable(res);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doc.merge(parsed.data.state as any);

    return res.json({
      merged: true,
      state: doc.toState(),
      value: doc.snapshot(),
    });
  });

  // GET /api/sessions/:id/crdt-peers — list peers and their vector clock versions
  app.get("/api/sessions/:id/crdt-peers", (req: Request, res: Response) => {
    if (!crdtPeerSync) return notAvailable(res);

    const sessionId = String(req.params.id);
    const peers = crdtPeerSync.getPeerVersions(sessionId);
    return res.json(peers);
  });

  // POST /api/sessions/:id/crdt-mode — set sync mode
  app.post("/api/sessions/:id/crdt-mode", (req: Request, res: Response) => {
    if (!crdtPeerSync) return notAvailable(res);

    const sessionId = String(req.params.id);
    const parsed = SetCRDTModeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid mode", issues: parsed.error.flatten() });
    }

    crdtPeerSync.setSyncMode(sessionId, parsed.data.mode);
    const doc = crdtPeerSync.getDocument(sessionId);

    return res.json({
      sessionId,
      syncMode: parsed.data.mode,
      state: doc ? doc.toState() : null,
    });
  });
}

// ─── Config-sync Conflict API (issue #323) ────────────────────────────────────

import type { IConflictStore } from "../federation/config-conflict";
import {
  resolveHumanConflict,
  dismissConflict,
} from "../federation/config-conflict";

// Validation schemas for conflict API
const ConflictQuerySchema = z.object({
  entityKind: z.string().optional(),
  status: z.enum(["detected", "pending_human", "auto_resolved", "human_resolved", "dismissed"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const ResolveConflictSchema = z.object({
  applyRemote: z.boolean(),
  resolutionNote: z.string().max(2000).optional(),
});

const DismissConflictSchema = z.object({
  resolutionNote: z.string().max(2000).optional(),
});

/**
 * Register config-sync conflict management API endpoints.
 *
 * GET    /api/federation/config-conflicts              — list open conflicts
 * GET    /api/federation/config-conflicts/:id          — get conflict by ID
 * POST   /api/federation/config-conflicts/:id/resolve  — human resolves (connection/provider-key)
 * POST   /api/federation/config-conflicts/:id/dismiss  — dismiss without applying
 * GET    /api/federation/config-conflicts/:id/audit    — audit trail for a conflict
 *
 * All routes require authentication (covered by upstream requireAuth middleware).
 */
export function registerConfigConflictRoutes(
  app: Router,
  conflictStore: IConflictStore | null,
): void {
  const notAvailable = (res: Response) =>
    res.status(503).json({ error: "Config conflict store is not available." });

  // GET /api/federation/config-conflicts — list conflicts
  app.get("/api/federation/config-conflicts", async (req: Request, res: Response) => {
    if (!conflictStore) return notAvailable(res);

    const parsed = ConflictQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", issues: parsed.error.flatten() });
    }

    try {
      const { entityKind, status } = parsed.data;
      const limit = parsed.data.limit ?? 100;

      if (status && !["detected", "pending_human"].includes(status)) {
        // For resolved/dismissed, we'd need full list — return empty for now
        // (the DB store can support filtering but in-memory only tracks open).
        return res.json({ conflicts: [], total: 0 });
      }

      const conflicts = await conflictStore.listOpenConflicts(entityKind);
      const sliced = conflicts.slice(0, limit);
      return res.json({ conflicts: sliced, total: conflicts.length });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/federation/config-conflicts/:id — get single conflict
  app.get("/api/federation/config-conflicts/:id", async (req: Request, res: Response) => {
    if (!conflictStore) return notAvailable(res);

    try {
      const conflict = await conflictStore.findOpenConflict("", "");
      // findOpenConflict doesn't support lookup by ID in the interface;
      // fall back to listing all and finding.
      const all = await conflictStore.listOpenConflicts();
      const found = all.find((c) => c.id === req.params.id);
      if (!found) {
        return res.status(404).json({ error: "Conflict not found or already resolved." });
      }
      return res.json(found);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/federation/config-conflicts/:id/resolve — human resolution
  app.post("/api/federation/config-conflicts/:id/resolve", async (req: Request, res: Response) => {
    if (!conflictStore) return notAvailable(res);

    const parsed = ResolveConflictSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const userId = (req as unknown as { user?: { id?: string } }).user?.id ?? "anonymous";
      const { conflict, applyEvent } = await resolveHumanConflict(
        conflictStore,
        String(req.params.id),
        `human:${userId}`,
        parsed.data.applyRemote,
        parsed.data.resolutionNote,
      );
      return res.json({ conflict, applyEvent });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("not open")) {
        return res.status(404).json({ error: msg });
      }
      if (msg.includes('not "human"')) {
        return res.status(409).json({ error: msg });
      }
      return res.status(500).json({ error: msg });
    }
  });

  // POST /api/federation/config-conflicts/:id/dismiss — dismiss without applying
  app.post("/api/federation/config-conflicts/:id/dismiss", async (req: Request, res: Response) => {
    if (!conflictStore) return notAvailable(res);

    const parsed = DismissConflictSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", issues: parsed.error.flatten() });
    }

    try {
      const userId = (req as unknown as { user?: { id?: string } }).user?.id ?? "anonymous";
      const conflict = await dismissConflict(
        conflictStore,
        String(req.params.id),
        `human:${userId}`,
        parsed.data.resolutionNote,
      );
      return res.json(conflict);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("not found") || msg.includes("not open")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(500).json({ error: msg });
    }
  });

  // GET /api/federation/config-conflicts/:id/audit — audit trail
  // NOTE: Only available when store is InMemoryConflictStore (test environments).
  // In production the audit would come from the DB layer.
  app.get("/api/federation/config-conflicts/:id/audit", async (req: Request, res: Response) => {
    if (!conflictStore) return notAvailable(res);

    // Check if the store exposes getAuditLog (InMemoryConflictStore does)
    const auditCapable = conflictStore as unknown as { getAuditLog?: () => Array<{ conflictId: string }> };
    if (typeof auditCapable.getAuditLog !== "function") {
      return res.status(501).json({ error: "Audit log not available on this store implementation." });
    }

    const entries = auditCapable.getAuditLog().filter((e) => e.conflictId === req.params.id);
    return res.json({ audit: entries, total: entries.length });
  });
}
