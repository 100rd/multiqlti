/**
 * CRDT Peer Sync Service
 *
 * Bridges the CRDT sync protocol with the existing FederationManager transport.
 * Hooks into federation message events to exchange CRDT state between instances.
 *
 * Federation messages used:
 *   crdt:push   — full state-based push from one peer to another
 *   crdt:ack    — acknowledgement with the receiver's current vector clock
 *
 * Sync mode is configurable per-session or globally:
 *   single_writer  — current default; CRDT sync is disabled
 *   crdt_p2p       — full P2P CRDT-based sync
 */

import type { FederationManager } from "../index.js";
import type { FederationMessage, PeerInfo } from "../types.js";
import { CRDTDocument } from "./document.js";
import { CRDTSyncManager, type CRDTDelta } from "./sync.js";
import type { VectorClockState } from "./vector-clock.js";

export type CollabSyncMode = "single_writer" | "crdt_p2p";

export interface PeerSyncOptions {
  /** Default sync mode for new sessions. */
  defaultMode?: CollabSyncMode;
  /** Anti-entropy interval in ms (0 = disabled). */
  antiEntropyIntervalMs?: number;
}

interface CrdtAckPayload {
  sessionId: string;
  receiverClock: VectorClockState;
}

export class CRDTPeerSyncService {
  private syncManager: CRDTSyncManager;
  /** sessionId → sync mode */
  private sessionModes = new Map<string, CollabSyncMode>();
  private defaultMode: CollabSyncMode;

  constructor(
    private readonly federation: FederationManager,
    private readonly nodeId: string,
    options: PeerSyncOptions = {},
  ) {
    this.defaultMode = options.defaultMode ?? "single_writer";

    this.syncManager = new CRDTSyncManager(
      nodeId,
      (peerId, delta) => this.sendDelta(peerId, delta),
      {
        antiEntropyIntervalMs: options.antiEntropyIntervalMs ?? 0,
        mode: "state",
      },
    );

    // Register federation message handlers
    this.federation.on("crdt:push", this.handlePush.bind(this));
    this.federation.on("crdt:ack", this.handleAck.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Get or create a CRDT document for a session.
   * If the session is in single_writer mode this returns undefined.
   */
  getOrCreateDocument(sessionId: string): CRDTDocument | undefined {
    const mode = this.sessionModes.get(sessionId) ?? this.defaultMode;
    if (mode !== "crdt_p2p") return undefined;

    let doc = this.syncManager.getDocument(sessionId);
    if (!doc) {
      doc = new CRDTDocument(sessionId, this.nodeId);
      this.syncManager.registerDocument(doc);
    }
    return doc;
  }

  /** Retrieve a managed document without creating it. */
  getDocument(sessionId: string): CRDTDocument | undefined {
    return this.syncManager.getDocument(sessionId);
  }

  /**
   * Set the sync mode for a session.
   * Switching to crdt_p2p automatically bootstraps a document and triggers
   * an immediate push to all connected peers.
   */
  setSyncMode(sessionId: string, mode: CollabSyncMode): void {
    this.sessionModes.set(sessionId, mode);

    if (mode === "crdt_p2p") {
      this.getOrCreateDocument(sessionId);
      this.pushToAllPeers(sessionId);
    }
  }

  /** Get the current sync mode for a session. */
  getSyncMode(sessionId: string): CollabSyncMode {
    return this.sessionModes.get(sessionId) ?? this.defaultMode;
  }

  /**
   * Push current CRDT state for a session to all connected peers.
   * Silently does nothing if the session is in single_writer mode.
   */
  pushToAllPeers(sessionId: string): void {
    const mode = this.sessionModes.get(sessionId) ?? this.defaultMode;
    if (mode !== "crdt_p2p") return;

    const doc = this.syncManager.getDocument(sessionId);
    if (!doc) return;

    const peerIds = this.federation.getPeers().map((p) => p.instanceId);
    this.syncManager.broadcast(sessionId, peerIds);
  }

  /**
   * Push current CRDT state to a specific peer.
   */
  pushToPeer(sessionId: string, peerId: string): void {
    const mode = this.sessionModes.get(sessionId) ?? this.defaultMode;
    if (mode !== "crdt_p2p") return;
    this.syncManager.push(sessionId, peerId);
  }

  /**
   * Retrieve the list of peers and their last-known vector clock versions.
   */
  getPeerVersions(sessionId: string): Array<{
    peerId: string;
    clock: VectorClockState | undefined;
  }> {
    const doc = this.syncManager.getDocument(sessionId);
    if (!doc) return [];

    return this.federation.getPeers().map((p) => ({
      peerId: p.instanceId,
      clock: this.syncManager.getPeerClock(p.instanceId),
    }));
  }

  /** Stop the sync service and the underlying anti-entropy loop. */
  stop(): void {
    this.syncManager.stop();
  }

  // ── Federation message handlers ─────────────────────────────────────────

  private handlePush(msg: FederationMessage, _peer: PeerInfo): void {
    const delta = msg.payload as CRDTDelta;
    const changed = this.syncManager.receive(delta);

    if (changed) {
      // Send an ack with our updated vector clock
      const doc = this.syncManager.getDocument(delta.sessionId);
      if (doc) {
        const ack: CrdtAckPayload = {
          sessionId: delta.sessionId,
          receiverClock: doc.vectorClock.toState(),
        };
        this.federation.send("crdt:ack", ack, msg.from);
      }
    }
  }

  private handleAck(msg: FederationMessage, _peer: PeerInfo): void {
    const payload = msg.payload as CrdtAckPayload;
    this.syncManager.updatePeerClock(msg.from, payload.receiverClock);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private sendDelta(peerId: string, delta: CRDTDelta): void {
    this.federation.send("crdt:push", delta, peerId);
  }
}
