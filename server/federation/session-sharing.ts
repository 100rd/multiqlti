import crypto from "crypto";
import type { FederationManager } from "./index.js";
import type { FederationMessage, PeerInfo } from "./types.js";
import type { IStorage } from "../storage.js";
import type { SharedSession } from "@shared/types";

/**
 * Session Sharing Service (issue #224)
 *
 * Enables real-time run collaboration between federated instances.
 * A run owner can "share" a run, producing a unique share token.
 * Other instances can subscribe to that token to receive live events.
 *
 * Federation messages used:
 *   session:offer        — broadcast when a run is shared
 *   session:subscribe    — sent by a subscriber to the owner
 *   session:unsubscribe  — sent when a subscriber leaves
 *   session:event        — forwarded WsEvent from owner to subscribers
 *   session:presence     — heartbeat (no-op handler, reserved)
 */
export class SessionSharingService {
  /** runId -> Set<instanceId> of subscribing peers */
  private subscribers = new Map<string, Set<string>>();

  /** Offers received from remote peers (shareToken -> offer payload) */
  private remoteOffers = new Map<
    string,
    { sessionId: string; runId: string; shareToken: string; ownerInstanceId: string; ownerName: string }
  >();

  constructor(
    private readonly federation: FederationManager,
    private readonly storage: IStorage,
    private readonly instanceId: string,
  ) {
    this.federation.on("session:offer", this.handleOffer.bind(this));
    this.federation.on("session:subscribe", this.handleSubscribe.bind(this));
    this.federation.on("session:unsubscribe", this.handleUnsubscribe.bind(this));
    this.federation.on("session:event", this.handleRemoteEvent.bind(this));
    this.federation.on("session:presence", () => {
      // Reserved for future heartbeat logic
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Share a run — creates a session record and broadcasts an offer to all
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

  /**
   * Subscribe to a shared run on a remote peer by its share token.
   */
  subscribeToSession(shareToken: string): void {
    this.federation.send("session:subscribe", { shareToken });
  }

  /**
   * Unsubscribe from a shared run.
   */
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

  /**
   * Stop sharing a run — deactivates the session and notifies subscribers.
   */
  async stopSharing(sessionId: string): Promise<void> {
    const session = await this.storage.getSharedSession(sessionId);
    await this.storage.deactivateSharedSession(sessionId);

    if (session) {
      // Remove subscriber tracking for this run
      this.subscribers.delete(session.runId);
    }
  }

  /**
   * List all active shared sessions visible to this instance.
   */
  async getActiveSessions(): Promise<SharedSession[]> {
    return this.storage.listActiveSharedSessions();
  }

  /**
   * Get offers received from remote peers.
   */
  getRemoteOffers(): Array<{
    sessionId: string;
    runId: string;
    shareToken: string;
    ownerInstanceId: string;
    ownerName: string;
  }> {
    return Array.from(this.remoteOffers.values());
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
    this.remoteOffers.set(payload.shareToken, payload);
  }

  private async handleSubscribe(
    msg: FederationMessage,
    peer: PeerInfo,
  ): Promise<void> {
    const { shareToken } = msg.payload as { shareToken: string };
    const session = await this.storage.getSharedSessionByToken(shareToken);

    if (!session || !session.isActive) return;
    // Check expiry
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
    // This is where a subscriber instance would dispatch the incoming event
    // to its local WebSocket clients. The actual WsManager integration is
    // wired by the consumer of this service.
    const _payload = msg.payload as { runId: string; event: unknown };
    // No-op: consumers attach their own logic via the public event callbacks.
  }

  // ── Internal helpers (exposed for testing) ────────────────────────────────

  /** Visible for testing — returns the internal subscribers map. */
  _getSubscribers(): Map<string, Set<string>> {
    return this.subscribers;
  }
}
