/**
 * CRDT Sync Protocol
 *
 * Two sync modes:
 *
 * 1. State-based sync: peers exchange full CRDT document state and merge locally.
 *    Simple and correct; bandwidth scales with document size.
 *
 * 2. Delta-based sync: only send changes since last sync (tracked by vector clock).
 *    Reduces bandwidth; falls back to full-state if delta is unavailable.
 *
 * Anti-entropy: periodic full-state exchange catches any missed deltas and
 * guarantees eventual convergence even with unreliable transports.
 */

import { CRDTDocument, type CRDTDocumentState } from "./document.js";
import { VectorClock, type VectorClockState } from "./vector-clock.js";

// ─── Delta Types ─────────────────────────────────────────────────────────────

/**
 * A delta represents the changes to a CRDT document since a known vector-clock
 * snapshot. Because we use state-based CRDTs, the "delta" is simply the full
 * state — the recipient's merge operation is idempotent, so resending already-
 * known state is safe (only wastes bandwidth, not correctness).
 *
 * Future optimization: track per-field dirty flags and only include changed
 * sub-documents in the delta.
 */
export interface CRDTDelta {
  sessionId: string;
  fromNodeId: string;
  /** The sender's vector clock at the time this delta was created. */
  senderClock: VectorClockState;
  /** The recipient's last-known clock (so the recipient can detect gaps). */
  sinceRecipientClock: VectorClockState | null;
  /** Full document state (used as the delta payload in this implementation). */
  state: CRDTDocumentState;
}

// ─── Sync Manager ────────────────────────────────────────────────────────────

export type SendFn = (peerId: string, delta: CRDTDelta) => void | Promise<void>;

export interface SyncOptions {
  /** Interval in ms for anti-entropy full-state broadcasts. 0 = disabled. */
  antiEntropyIntervalMs?: number;
  /** Sync mode. Defaults to "state". */
  mode?: "state" | "delta";
}

export class CRDTSyncManager {
  /** sessionId → document */
  private documents = new Map<string, CRDTDocument>();

  /**
   * nodeId → last-known vector clock for that peer
   * Used to construct deltas that only include new information.
   */
  private peerClocks = new Map<string, VectorClockState>();

  private antiEntropyHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private nodeId: string,
    private sendFn: SendFn,
    private options: SyncOptions = {},
  ) {
    if ((options.antiEntropyIntervalMs ?? 0) > 0) {
      this.antiEntropyHandle = setInterval(
        () => this.runAntiEntropy(),
        options.antiEntropyIntervalMs,
      );
    }
  }

  // ── Document lifecycle ────────────────────────────────────────────────────

  /** Register a document for sync management. */
  registerDocument(doc: CRDTDocument): void {
    this.documents.set(doc.sessionId, doc);
  }

  /** Retrieve a managed document by session ID. */
  getDocument(sessionId: string): CRDTDocument | undefined {
    return this.documents.get(sessionId);
  }

  /** Remove a document from sync management (e.g., session ended). */
  unregisterDocument(sessionId: string): void {
    this.documents.delete(sessionId);
  }

  // ── Outbound sync ─────────────────────────────────────────────────────────

  /**
   * Push current document state to all known peers (full-state mode)
   * or a delta since the last known peer clock (delta mode).
   */
  push(sessionId: string, peerId: string): void {
    const doc = this.documents.get(sessionId);
    if (!doc) return;

    const sinceRecipientClock =
      this.options.mode === "delta"
        ? (this.peerClocks.get(peerId) ?? null)
        : null;

    const delta: CRDTDelta = {
      sessionId,
      fromNodeId: this.nodeId,
      senderClock: doc.vectorClock.toState(),
      sinceRecipientClock,
      state: doc.toState(),
    };

    void this.sendFn(peerId, delta);
  }

  /**
   * Broadcast document state to all given peer IDs.
   */
  broadcast(sessionId: string, peerIds: string[]): void {
    for (const peerId of peerIds) {
      this.push(sessionId, peerId);
    }
  }

  // ── Inbound sync ──────────────────────────────────────────────────────────

  /**
   * Receive and apply an incoming delta from a remote peer.
   * Merges the state into the local document and updates the peer clock record.
   *
   * Returns true if the merge changed the local document, false if it was a no-op.
   */
  receive(delta: CRDTDelta): boolean {
    const { sessionId, fromNodeId, senderClock, state } = delta;

    let doc = this.documents.get(sessionId);
    if (!doc) {
      // Bootstrap a new document from the incoming state
      doc = CRDTDocument.fromState(state);
      this.documents.set(sessionId, doc);
      this.peerClocks.set(fromNodeId, senderClock);
      return true;
    }

    const localClock = doc.vectorClock.toState();
    const vc = VectorClock.fromState(this.nodeId, localClock);
    const relation = vc.compare(senderClock);

    // Only skip if we are strictly after the sender — meaning our state is
    // a superset of theirs. In all other cases (concurrent, equal, before)
    // we perform the merge because:
    //   - "before": sender has info we lack
    //   - "concurrent": each side has independent info
    //   - "equal": vector clocks match but state-based mutations may have
    //     happened without ticking the clock (e.g., ORSet add uses UUIDs,
    //     not the vector clock counter). Merging is always safe (idempotent).
    if (relation === "after") {
      // Our state strictly dominates — skip for bandwidth optimisation.
      this.peerClocks.set(fromNodeId, senderClock);
      return false;
    }

    // Merge the incoming state (idempotent)
    doc.merge(state);

    // Record the sender's clock so we can compute deltas for them later
    this.peerClocks.set(fromNodeId, senderClock);
    return true;
  }

  // ── Anti-entropy ──────────────────────────────────────────────────────────

  /**
   * Run an anti-entropy pass: broadcast full state of all managed documents
   * to all known peers. This converges any missed deltas.
   */
  private runAntiEntropy(): void {
    const peerIds = Array.from(this.peerClocks.keys());
    if (peerIds.length === 0) return;

    for (const [sessionId] of this.documents) {
      this.broadcast(sessionId, peerIds);
    }
  }

  // ── Peer clock management ─────────────────────────────────────────────────

  /** Record or update a peer's last-known vector clock. */
  updatePeerClock(peerId: string, clock: VectorClockState): void {
    this.peerClocks.set(peerId, clock);
  }

  /** Retrieve a peer's last-known vector clock. */
  getPeerClock(peerId: string): VectorClockState | undefined {
    return this.peerClocks.get(peerId);
  }

  /** Get all peer IDs currently tracked. */
  getTrackedPeerIds(): string[] {
    return Array.from(this.peerClocks.keys());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Stop the anti-entropy interval (for graceful shutdown). */
  stop(): void {
    if (this.antiEntropyHandle) {
      clearInterval(this.antiEntropyHandle);
      this.antiEntropyHandle = null;
    }
  }
}
