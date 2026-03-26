import crypto from "crypto";
import type { FederationManager } from "./index.js";
import type { FederationMessage, PeerInfo } from "./types.js";
import type { IStorage } from "../storage.js";
import type { SharedSession, HandoffBundle, PresenceEntry } from "@shared/types";

const PRESENCE_TIMEOUT_MS = 10_000;
const MAX_PENDING_HANDOFFS = 50;
const MAX_REMOTE_OFFERS = 200;
const MAX_PRESENCE_SESSIONS = 500;

/**
 * Session Sharing Service (issue #224 + #226)
 *
 * Enables real-time run collaboration between federated instances.
 * A run owner can "share" a run, producing a unique share token.
 * Other instances can subscribe to that token to receive live events.
 *
 * Federation messages used:
 *   session:offer        -- broadcast when a run is shared
 *   session:subscribe    -- sent by a subscriber to the owner
 *   session:unsubscribe  -- sent when a subscriber leaves
 *   session:event        -- forwarded WsEvent from owner to subscribers
 *   session:presence     -- heartbeat for active user tracking
 *   session:handoff      -- full context transfer to target peer
 *   session:handoff:accept -- target acknowledges handoff
 */
export class SessionSharingService {
  /** runId -> Set<instanceId> of subscribing peers */
  private subscribers = new Map<string, Set<string>>();

  /** Offers received from remote peers (shareToken -> offer payload) */
  private remoteOffers = new Map<
    string,
    { sessionId: string; runId: string; shareToken: string; ownerInstanceId: string; ownerName: string }
  >();

  /** Pending handoff bundles keyed by a one-time token */
  private pendingHandoffs = new Map<string, HandoffBundle>();

  /** sessionId -> Map<compositeKey, PresenceEntry> */
  private presenceMap = new Map<string, Map<string, PresenceEntry>>();

  /** Interval handle for presence sweep */
  private presenceSweepHandle: ReturnType<typeof setInterval> | null = null;

  /** Optional callback for broadcasting WsEvents to local clients */
  private wsEventCallback?: (runId: string, event: Record<string, unknown>) => void;

  constructor(
    private readonly federation: FederationManager,
    private readonly storage: IStorage,
    private readonly instanceId: string,
  ) {
    this.federation.on("session:offer", this.handleOffer.bind(this));
    this.federation.on("session:subscribe", this.handleSubscribe.bind(this));
    this.federation.on("session:unsubscribe", this.handleUnsubscribe.bind(this));
    this.federation.on("session:event", this.handleRemoteEvent.bind(this));
    this.federation.on("session:presence", this.handlePresence.bind(this));
    this.federation.on("session:handoff", this.handleHandoffReceived.bind(this));
    this.federation.on("session:handoff:accept", this.handleHandoffAccepted.bind(this));

    this.startPresenceSweep();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Register a callback for broadcasting WsEvents to local clients. */
  onWsEvent(callback: (runId: string, event: Record<string, unknown>) => void): void {
    this.wsEventCallback = callback;
  }

  /**
   * Share a run -- creates a session record and broadcasts an offer to all
   * federation peers.
   */
  async shareRun(
    runId: string,
    userId: string,
    expiresIn?: number,
  ): Promise<SharedSession> {
    const shareToken = crypto.randomBytes(24).toString("hex");
    const session = await this.storage.createSharedSession({
      runId,
      shareToken,
      ownerInstanceId: this.instanceId,
      createdBy: userId,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn) : null,
    });

    this.federation.send("session:offer", {
      sessionId: session.id,
      runId,
      shareToken,
      ownerInstanceId: this.instanceId,
      ownerName: userId,
    });

    return session;
  }

  /** Subscribe to a shared run on a remote peer by its share token. */
  subscribeToSession(shareToken: string): void {
    this.federation.send("session:subscribe", { shareToken });
  }

  /** Unsubscribe from a shared run. */
  unsubscribeFromSession(shareToken: string): void {
    this.federation.send("session:unsubscribe", { shareToken });
  }

  /**
   * Forward a WsEvent to all subscribers of a run.
   * Called by the local WsManager whenever an event fires on a shared run.
   */
  forwardEvent(runId: string, event: unknown): void {
    const subs = this.subscribers.get(runId);
    if (!subs || subs.size === 0) return;

    for (const peerInstanceId of subs) {
      this.federation.send("session:event", { runId, event }, peerInstanceId);
    }
  }

  /** Stop sharing a run -- deactivates the session and notifies subscribers. */
  async stopSharing(sessionId: string): Promise<void> {
    const session = await this.storage.getSharedSession(sessionId);
    await this.storage.deactivateSharedSession(sessionId);

    if (session) {
      this.subscribers.delete(session.runId);
    }
  }

  /** List all active shared sessions visible to this instance. */
  async getActiveSessions(): Promise<SharedSession[]> {
    return this.storage.listActiveSharedSessions();
  }

  /** Get offers received from remote peers. */
  getRemoteOffers(): Array<{
    sessionId: string;
    runId: string;
    shareToken: string;
    ownerInstanceId: string;
    ownerName: string;
  }> {
    return Array.from(this.remoteOffers.values());
  }

  // ── Handoff API (issue #226) ───────────────────────────────────────────────

  /** Assemble a full context bundle from storage for a given run. */
  async createHandoffBundle(runId: string, notes: string): Promise<HandoffBundle> {
    const run = await this.storage.getPipelineRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const pipeline = await this.storage.getPipeline(run.pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${run.pipelineId} not found`);

    const [stages, chatHistory, memories, llmResult] = await Promise.all([
      this.storage.getStageExecutions(runId),
      this.storage.getChatMessages(runId),
      this.storage.getMemories("run", runId),
      this.storage.getLlmRequests({ runId, limit: 500 }),
    ]);

    return {
      run: this.sanitizeRecord(run),
      pipeline: this.sanitizeRecord(pipeline),
      stages: stages.map((s) => this.sanitizeRecord(s)),
      chatHistory: chatHistory.map((c) => this.sanitizeRecord(c)),
      memories: memories.map((m) => this.sanitizeRecord(m)),
      llmRequests: llmResult.rows.map((r) => this.sanitizeRecord(r)),
      notes,
    };
  }

  /** Send a handoff bundle to a target peer via federation. */
  async sendHandoff(
    sessionId: string,
    targetPeerId: string,
    notes: string,
  ): Promise<string> {
    const session = await this.storage.getSharedSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const bundle = await this.createHandoffBundle(session.runId, notes);
    const bundleToken = crypto.randomBytes(24).toString("hex");

    this.federation.send("session:handoff", {
      bundleToken,
      sessionId,
      bundle,
      fromInstanceId: this.instanceId,
    }, targetPeerId);

    return bundleToken;
  }

  /** Accept an incoming handoff bundle and create a new run from it. */
  async acceptHandoff(bundleToken: string): Promise<{ runId: string }> {
    const bundle = this.pendingHandoffs.get(bundleToken);
    if (!bundle) throw new Error("Handoff bundle not found or expired");

    this.pendingHandoffs.delete(bundleToken);

    const originalRun = bundle.run as Record<string, unknown>;
    const newRun = await this.storage.createPipelineRun({
      pipelineId: originalRun.pipelineId as string,
      status: "pending",
      input: `[Handoff] ${bundle.notes}\n\nOriginal input: ${originalRun.input as string}`,
      currentStageIndex: 0,
    });

    // Mark original run as handed off
    const originalRunId = originalRun.id as string;
    await this.storage.updatePipelineRun(originalRunId, {
      status: "handed_off",
      completedAt: new Date(),
    });

    // Re-create chat history in new run
    for (const msg of bundle.chatHistory) {
      await this.storage.createChatMessage({
        runId: newRun.id,
        role: msg.role as string,
        content: `[Handoff context] ${msg.content as string}`,
        agentTeam: (msg.agentTeam as string) ?? null,
        modelSlug: (msg.modelSlug as string) ?? null,
        metadata: msg.metadata ?? null,
      });
    }

    // Notify the original owner
    this.federation.send("session:handoff:accept", {
      bundleToken,
      newRunId: newRun.id,
      acceptedBy: this.instanceId,
    });

    return { runId: newRun.id };
  }

  /** List pending incoming handoff bundles. */
  getPendingHandoffs(): Array<{
    bundleToken: string;
    notes: string;
    originalRunId: string;
    pipelineId: string;
  }> {
    const result: Array<{
      bundleToken: string;
      notes: string;
      originalRunId: string;
      pipelineId: string;
    }> = [];

    for (const [token, bundle] of this.pendingHandoffs) {
      result.push({
        bundleToken: token,
        notes: bundle.notes,
        originalRunId: (bundle.run as Record<string, unknown>).id as string,
        pipelineId: (bundle.pipeline as Record<string, unknown>).id as string,
      });
    }

    return result;
  }

  // ── Presence API (issue #226) ──────────────────────────────────────────────

  /** Record a presence heartbeat for a user in a session. */
  recordPresence(sessionId: string, userId: string): void {
    let sessionPresence = this.presenceMap.get(sessionId);
    if (!sessionPresence) {
      sessionPresence = new Map();
      this.presenceMap.set(sessionId, sessionPresence);
    }

    const key = `${this.instanceId}::${userId}`;
    const isNew = !sessionPresence.has(key);

    sessionPresence.set(key, {
      userId,
      instanceId: this.instanceId,
      lastHeartbeat: Date.now(),
    });

    // Broadcast to federation peers
    this.federation.send("session:presence", {
      sessionId,
      userId,
      instanceId: this.instanceId,
    });

    if (isNew) {
      this.emitPresenceEvent(sessionId, userId, this.instanceId, "joined");
    }
  }

  /** Get active presence entries for a session. */
  getSessionPresence(sessionId: string): PresenceEntry[] {
    const sessionPresence = this.presenceMap.get(sessionId);
    if (!sessionPresence) return [];

    const now = Date.now();
    const active: PresenceEntry[] = [];
    for (const entry of sessionPresence.values()) {
      if (now - entry.lastHeartbeat < PRESENCE_TIMEOUT_MS) {
        active.push(entry);
      }
    }
    return active;
  }

  /** Stop the presence sweep interval (for graceful shutdown). */
  stopPresenceSweep(): void {
    if (this.presenceSweepHandle) {
      clearInterval(this.presenceSweepHandle);
      this.presenceSweepHandle = null;
    }
  }

  // ── Federation message handlers ──────────────────────────────────────────────

  private handleOffer(msg: FederationMessage, _peer: PeerInfo): void {
    const payload = msg.payload as {
      sessionId: string;
      runId: string;
      shareToken: string;
      ownerInstanceId: string;
      ownerName: string;
    };
    if (this.remoteOffers.size >= MAX_REMOTE_OFFERS) {
      const oldest = this.remoteOffers.keys().next().value;
      if (oldest !== undefined) this.remoteOffers.delete(oldest);
    }
    this.remoteOffers.set(payload.shareToken, payload);
  }

  private async handleSubscribe(
    msg: FederationMessage,
    peer: PeerInfo,
  ): Promise<void> {
    const { shareToken } = msg.payload as { shareToken: string };
    const session = await this.storage.getSharedSessionByToken(shareToken);

    if (!session || !session.isActive) return;
    if (session.expiresAt && session.expiresAt < new Date()) return;

    let subs = this.subscribers.get(session.runId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(session.runId, subs);
    }
    subs.add(peer.instanceId);
  }

  private async handleUnsubscribe(
    msg: FederationMessage,
    peer: PeerInfo,
  ): Promise<void> {
    const { shareToken } = msg.payload as { shareToken: string };
    const session = await this.storage.getSharedSessionByToken(shareToken);
    if (!session) return;

    const subs = this.subscribers.get(session.runId);
    if (subs) {
      subs.delete(peer.instanceId);
      if (subs.size === 0) {
        this.subscribers.delete(session.runId);
      }
    }
  }

  private handleRemoteEvent(msg: FederationMessage, _peer: PeerInfo): void {
    const payload = msg.payload as { runId: string; event: Record<string, unknown> };
    if (this.wsEventCallback) {
      this.wsEventCallback(payload.runId, payload.event);
    }
  }

  private handlePresence(msg: FederationMessage, _peer: PeerInfo): void {
    const payload = msg.payload as {
      sessionId: string;
      userId: string;
      instanceId: string;
    };

    let sessionPresence = this.presenceMap.get(payload.sessionId);
    if (!sessionPresence) {
      if (this.presenceMap.size >= MAX_PRESENCE_SESSIONS) {
        const oldest = this.presenceMap.keys().next().value;
        if (oldest !== undefined) this.presenceMap.delete(oldest);
      }
      sessionPresence = new Map();
      this.presenceMap.set(payload.sessionId, sessionPresence);
    }

    const key = `${payload.instanceId}::${payload.userId}`;
    const isNew = !sessionPresence.has(key);

    sessionPresence.set(key, {
      userId: payload.userId,
      instanceId: payload.instanceId,
      lastHeartbeat: Date.now(),
    });

    if (isNew) {
      this.emitPresenceEvent(
        payload.sessionId,
        payload.userId,
        payload.instanceId,
        "joined",
      );
    }
  }

  private handleHandoffReceived(msg: FederationMessage, _peer: PeerInfo): void {
    const payload = msg.payload as {
      bundleToken: string;
      sessionId: string;
      bundle: HandoffBundle;
      fromInstanceId: string;
    };
    if (this.pendingHandoffs.size >= MAX_PENDING_HANDOFFS) {
      const oldest = this.pendingHandoffs.keys().next().value;
      if (oldest !== undefined) this.pendingHandoffs.delete(oldest);
    }
    this.pendingHandoffs.set(payload.bundleToken, payload.bundle);
  }

  private handleHandoffAccepted(msg: FederationMessage, _peer: PeerInfo): void {
    // The sender receives confirmation that the handoff was accepted.
    // This could trigger local UI updates via the wsEventCallback.
    const payload = msg.payload as {
      bundleToken: string;
      newRunId: string;
      acceptedBy: string;
    };
    if (this.wsEventCallback) {
      this.wsEventCallback("", {
        type: "federation:handoff:accepted",
        payload: {
          bundleToken: payload.bundleToken,
          newRunId: payload.newRunId,
          acceptedBy: payload.acceptedBy,
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Remove sensitive fields from records before including in handoff bundles. */
  private sanitizeRecord(record: object): Record<string, unknown> {
    const sanitized: Record<string, unknown> = { ...(record as Record<string, unknown>) };
    const sensitiveKeys = ["apiKey", "secretKey", "password", "token", "secret"];
    for (const key of sensitiveKeys) {
      if (key in sanitized) {
        delete sanitized[key];
      }
    }
    return sanitized;
  }











  /** Emit a presence join/leave WsEvent via the callback. */
  private emitPresenceEvent(
    sessionId: string,
    userId: string,
    eventInstanceId: string,
    action: "joined" | "left",
  ): void {
    if (!this.wsEventCallback) return;
    const eventType = action === "joined"
      ? "federation:user_joined"
      : "federation:user_left";

    this.wsEventCallback(sessionId, {
      type: eventType,
      payload: { userId, instanceId: eventInstanceId, sessionId },
      timestamp: new Date().toISOString(),
    });
  }

  /** Periodically sweep expired presence entries. */
  private startPresenceSweep(): void {
    const sweepIntervalMs = 5_000;
    this.presenceSweepHandle = setInterval(() => {
      this.sweepExpiredPresence();
    }, sweepIntervalMs);
  }

  /** Remove entries that have not heartbeated within the timeout. */
  private sweepExpiredPresence(): void {
    const now = Date.now();

    for (const [sessionId, sessionPresence] of this.presenceMap) {
      for (const [key, entry] of sessionPresence) {
        if (now - entry.lastHeartbeat >= PRESENCE_TIMEOUT_MS) {
          sessionPresence.delete(key);
          this.emitPresenceEvent(
            sessionId,
            entry.userId,
            entry.instanceId,
            "left",
          );
        }
      }
      if (sessionPresence.size === 0) {
        this.presenceMap.delete(sessionId);
      }
    }
  }

  // ── Internal helpers (exposed for testing) ────────────────────────────────

  /** Visible for testing -- returns the internal subscribers map. */
  _getSubscribers(): Map<string, Set<string>> {
    return this.subscribers;
  }

  /** Visible for testing -- returns the pending handoffs map. */
  _getPendingHandoffs(): Map<string, HandoffBundle> {
    return this.pendingHandoffs;
  }

  /** Visible for testing -- returns the presence map. */
  _getPresenceMap(): Map<string, Map<string, PresenceEntry>> {
    return this.presenceMap;
  }

  /** Visible for testing -- trigger a single sweep pass. */
  _sweepExpiredPresence(): void {
    this.sweepExpiredPresence();
  }
}
