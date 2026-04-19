/**
 * peer-queue.ts — Per-peer offline queue for config-sync events.
 *
 * Issue #322: Config sync: offline queue per peer with TTL + coalesce
 *
 * Architecture:
 *
 *  Table `peer_pending_events` holds one row per (peer_id, event_id).
 *  Each row references a row in `config_events_outbox`.
 *
 *  Key behaviours:
 *
 *  1. Enqueue on send failure
 *     When the publisher fails to deliver an event to a specific peer the
 *     caller invokes `PeerQueueService.enqueue(peerId, eventId, entityKind, entityId)`.
 *     Before inserting, any existing *pending* row for the same
 *     (peer_id, entity_kind, entity_id) is deleted (coalesce).
 *
 *  2. Flush on reconnect
 *     When a heartbeat is received from a peer the caller invokes
 *     `PeerQueueService.flush(peerId, sendFn)`.  Events are sent in
 *     enqueued_at ASC order.  Success marks them `sent`; continued failure
 *     increments `retry_count` and updates `last_retry_at`.
 *
 *  3. Coalesce
 *     Multiple updates to the same entity collapse to the newest event:
 *     the old pending row is removed and replaced with the new one.
 *
 *  4. TTL
 *     `PeerQueueService.pruneTTL()` deletes rows older than
 *     `ttlMs` (default 7 days) and, for affected peers, signals that they
 *     require a full resync.
 *
 *  5. Circuit breaker
 *     When a peer's pending queue depth exceeds `circuitBreakerThreshold`
 *     (default 500) the peer is marked suspended and an alert callback is
 *     invoked.  The circuit stays open until the queue drains below the
 *     threshold or is manually reset.
 *
 *  6. Metrics
 *     `PeerQueueService.getMetrics(peerId?)` returns queue depth, oldest
 *     event age, and coalesce ratio per peer.
 */

import crypto from "crypto";
import type { PeerPendingStatus } from "@shared/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default TTL for pending events: 7 days in milliseconds. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** Default circuit-breaker threshold: suspend peer when queue depth exceeds this. */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 500;

/** Maximum events fetched per flush call per peer. */
const FLUSH_BATCH_SIZE = 200;

// ─── Public types ─────────────────────────────────────────────────────────────

/** Row returned by the queue store. */
export interface PendingEventRow {
  peerId: string;
  eventId: string;
  enqueuedAt: Date;
  lastRetryAt: Date | null;
  retryCount: number;
  status: PeerPendingStatus;
  /** Event details from the outbox join — included so flush can reconstruct the payload. */
  entityKind: string;
  entityId: string;
  operation: string;
  payloadJsonb: Record<string, unknown>;
  createdAt: Date;
}

/** Signal sent to a peer when its queue TTL has expired and it needs a full resync. */
export interface ResyncSignal {
  peerId: string;
  reason: "ttl_expired";
  expiredCount: number;
}

/** Per-peer metrics snapshot. */
export interface PeerQueueMetrics {
  peerId: string;
  /** Number of events currently in `pending` status. */
  pendingDepth: number;
  /** Age (ms) of the oldest pending event, or 0 if queue is empty. */
  oldestEventAgeMs: number;
  /**
   * Coalesce ratio: events coalesced / events enqueued (lifetime, in-memory
   * counter).  Resets on process restart.
   */
  coalesceRatio: number;
  /** Whether the circuit breaker is currently open (peer suspended). */
  circuitOpen: boolean;
}

/**
 * Storage interface for the peer queue.
 * The production adapter wraps Drizzle / raw Postgres; the in-memory
 * implementation is used in unit tests.
 */
export interface IPeerQueueStore {
  /**
   * Remove the existing pending row for (peerId, entityKind, entityId) if any,
   * then insert a new pending row for (peerId, eventId).
   * Returns `true` if a previous row was coalesced (replaced), `false` if this
   * was a fresh enqueue.
   */
  coalesceAndEnqueue(
    peerId: string,
    eventId: string,
    entityKind: string,
    entityId: string,
  ): Promise<boolean>;

  /**
   * Fetch up to `limit` pending events for `peerId` ordered by enqueued_at ASC.
   * Returns rows with outbox join fields.
   */
  getPendingEvents(peerId: string, limit: number): Promise<PendingEventRow[]>;

  /**
   * Mark the given (peerId, eventId) rows as `sent`.
   */
  markSent(peerId: string, eventIds: string[]): Promise<void>;

  /**
   * Increment `retry_count` and set `last_retry_at = now()` for the given
   * (peerId, eventId) pairs.
   */
  recordRetryFailure(peerId: string, eventIds: string[]): Promise<void>;

  /**
   * Delete all `pending` rows with `enqueued_at < cutoff`.
   * Returns the set of peer IDs that had at least one row deleted.
   */
  deleteExpiredRows(cutoffDate: Date): Promise<Set<string>>;

  /**
   * Count pending events for `peerId` (used by circuit breaker check).
   */
  countPending(peerId: string): Promise<number>;

  /**
   * Return the oldest pending enqueued_at for `peerId`, or null if empty.
   */
  oldestPendingEnqueuedAt(peerId: string): Promise<Date | null>;
}

/** Callback invoked when the circuit breaker opens for a peer. */
export type CircuitBreakerAlertFn = (peerId: string, queueDepth: number) => void;

/** Callback invoked when a peer requires a full resync due to TTL expiry. */
export type ResyncSignalFn = (signal: ResyncSignal) => void;

/** Function that delivers one event payload to a peer — returns true on success. */
export type SendEventFn = (
  peerId: string,
  eventId: string,
  entityKind: string,
  entityId: string,
  operation: string,
  payload: Record<string, unknown>,
) => Promise<boolean>;

export interface PeerQueueOptions {
  /** TTL for pending events (ms). Default: 7 days. */
  ttlMs?: number;
  /** Queue depth that triggers the circuit breaker. Default: 500. */
  circuitBreakerThreshold?: number;
  /** Called when the circuit breaker opens. */
  onCircuitOpen?: CircuitBreakerAlertFn;
  /** Called when a peer needs a full resync after TTL expiry. */
  onResyncRequired?: ResyncSignalFn;
}

// ─── Main service ─────────────────────────────────────────────────────────────

/**
 * Per-peer offline event queue with coalesce, TTL, circuit breaker,
 * and per-peer metrics.
 *
 * Lifecycle:
 *   ```ts
 *   const queue = new PeerQueueService(store, options);
 *   // On send failure:
 *   await queue.enqueue(peerId, eventId, entityKind, entityId);
 *   // On peer reconnect:
 *   await queue.flush(peerId, sendFn);
 *   // Periodically (e.g. every hour):
 *   await queue.pruneTTL();
 *   ```
 */
export class PeerQueueService {
  private readonly ttlMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly onCircuitOpen: CircuitBreakerAlertFn;
  private readonly onResyncRequired: ResyncSignalFn;

  /** In-memory circuit state: peerId → open. Resets on process restart. */
  private readonly circuitOpen = new Set<string>();

  /** Lifetime coalesce counters per peer: peerId → { enqueued, coalesced }. */
  private readonly coalesceCounts = new Map<string, { enqueued: number; coalesced: number }>();

  constructor(
    private readonly store: IPeerQueueStore,
    options: PeerQueueOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.onCircuitOpen = options.onCircuitOpen ?? (() => undefined);
    this.onResyncRequired = options.onResyncRequired ?? (() => undefined);
  }

  // ── Enqueue ──────────────────────────────────────────────────────────────────

  /**
   * Enqueue an event for a peer that could not be reached.
   *
   * Steps:
   *   1. Check circuit breaker — if open, do not enqueue (event is dropped).
   *   2. Coalesce: remove any existing pending event for the same entity.
   *   3. Insert the new pending row.
   *   4. Re-check queue depth — open circuit if threshold exceeded.
   *
   * @returns `"enqueued"` | `"coalesced"` | `"circuit_open"`
   */
  async enqueue(
    peerId: string,
    eventId: string,
    entityKind: string,
    entityId: string,
  ): Promise<"enqueued" | "coalesced" | "circuit_open"> {
    if (this.circuitOpen.has(peerId)) {
      return "circuit_open";
    }

    const coalesced = await this.store.coalesceAndEnqueue(peerId, eventId, entityKind, entityId);

    const counters = this.getCoalesceCounters(peerId);
    counters.enqueued += 1;
    if (coalesced) {
      counters.coalesced += 1;
    }

    // Check circuit breaker after enqueue.
    const depth = await this.store.countPending(peerId);
    if (depth >= this.circuitBreakerThreshold) {
      this.circuitOpen.add(peerId);
      this.onCircuitOpen(peerId, depth);
    }

    return coalesced ? "coalesced" : "enqueued";
  }

  // ── Flush ─────────────────────────────────────────────────────────────────────

  /**
   * Flush the queue for `peerId`.
   *
   * Fetches pending events in enqueued_at ASC order, calls `sendFn` for each,
   * marks successes as `sent`, and records failures for retry.
   *
   * If the circuit is open, closes it first then proceeds — a successful
   * reconnect (heartbeat) implies the peer is reachable.
   *
   * @returns counts of events sent and failed in this flush batch.
   */
  async flush(
    peerId: string,
    sendFn: SendEventFn,
  ): Promise<{ sent: number; failed: number }> {
    // A reconnect resets the circuit breaker so the peer can be re-enabled.
    this.circuitOpen.delete(peerId);

    const rows = await this.store.getPendingEvents(peerId, FLUSH_BATCH_SIZE);
    if (rows.length === 0) {
      return { sent: 0, failed: 0 };
    }

    const sentIds: string[] = [];
    const failedIds: string[] = [];

    for (const row of rows) {
      const ok = await sendFn(
        row.peerId,
        row.eventId,
        row.entityKind,
        row.entityId,
        row.operation,
        row.payloadJsonb,
      );

      if (ok) {
        sentIds.push(row.eventId);
      } else {
        failedIds.push(row.eventId);
      }
    }

    const ops: Array<Promise<void>> = [];
    if (sentIds.length > 0) {
      ops.push(this.store.markSent(peerId, sentIds));
    }
    if (failedIds.length > 0) {
      ops.push(this.store.recordRetryFailure(peerId, failedIds));
    }
    await Promise.all(ops);

    return { sent: sentIds.length, failed: failedIds.length };
  }

  // ── TTL pruning ───────────────────────────────────────────────────────────────

  /**
   * Delete events older than `ttlMs` and signal affected peers to perform a
   * full resync.
   *
   * @returns the set of peer IDs that had rows deleted.
   */
  async pruneTTL(): Promise<Set<string>> {
    const cutoff = new Date(Date.now() - this.ttlMs);
    const affectedPeers = await this.store.deleteExpiredRows(cutoff);

    for (const peerId of affectedPeers) {
      this.onResyncRequired({
        peerId,
        reason: "ttl_expired",
        expiredCount: 0, // store does not return exact count per peer — kept for interface
      });
    }

    return affectedPeers;
  }

  // ── Circuit breaker ───────────────────────────────────────────────────────────

  /** Whether the circuit is currently open for a peer. */
  isCircuitOpen(peerId: string): boolean {
    return this.circuitOpen.has(peerId);
  }

  /**
   * Manually reset the circuit breaker for a peer (e.g. after operator review).
   */
  resetCircuit(peerId: string): void {
    this.circuitOpen.delete(peerId);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────────

  /**
   * Get queue metrics for one peer (or a summary across all known peers
   * when `peerId` is omitted, returning one entry per peer that has ever
   * had activity tracked in this process lifetime).
   */
  async getMetrics(peerId: string): Promise<PeerQueueMetrics> {
    const depth = await this.store.countPending(peerId);
    const oldest = await this.store.oldestPendingEnqueuedAt(peerId);
    const ageMs = oldest ? Date.now() - oldest.getTime() : 0;
    const counters = this.getCoalesceCounters(peerId);
    const ratio = counters.enqueued === 0 ? 0 : counters.coalesced / counters.enqueued;

    return {
      peerId,
      pendingDepth: depth,
      oldestEventAgeMs: ageMs,
      coalesceRatio: ratio,
      circuitOpen: this.circuitOpen.has(peerId),
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  private getCoalesceCounters(peerId: string): { enqueued: number; coalesced: number } {
    let c = this.coalesceCounts.get(peerId);
    if (!c) {
      c = { enqueued: 0, coalesced: 0 };
      this.coalesceCounts.set(peerId, c);
    }
    return c;
  }
}

// ─── In-memory store (for tests) ─────────────────────────────────────────────

/**
 * In-memory implementation of `IPeerQueueStore`.
 *
 * Used in unit tests.  All data is volatile and reset between tests via
 * `reset()`.  The coalesce logic here mirrors what the production SQL adapter
 * does inside a transaction.
 */
export class InMemoryPeerQueueStore implements IPeerQueueStore {
  /**
   * Map key: `${peerId}::${eventId}`.
   * The value contains both the queue row and the outbox event details
   * (normally accessed via JOIN in SQL).
   */
  private rows = new Map<string, PendingEventRow>();

  /**
   * Secondary index: `${peerId}::${entityKind}::${entityId}` → eventId.
   * Used by coalesce to find the existing pending event for an entity.
   */
  private entityIndex = new Map<string, string>();

  async coalesceAndEnqueue(
    peerId: string,
    eventId: string,
    entityKind: string,
    entityId: string,
  ): Promise<boolean> {
    const entityKey = entityIndexKey(peerId, entityKind, entityId);
    const existingEventId = this.entityIndex.get(entityKey);
    let coalesced = false;

    if (existingEventId !== undefined) {
      // Remove the old pending row — the new event supersedes it.
      this.rows.delete(rowKey(peerId, existingEventId));
      this.entityIndex.delete(entityKey);
      coalesced = true;
    }

    this.rows.set(rowKey(peerId, eventId), {
      peerId,
      eventId,
      enqueuedAt: new Date(),
      lastRetryAt: null,
      retryCount: 0,
      status: "pending",
      entityKind,
      entityId,
      operation: "update",
      payloadJsonb: {},
      createdAt: new Date(),
    });
    this.entityIndex.set(entityKey, eventId);

    return coalesced;
  }

  /**
   * Override to inject outbox payload for testing — the base coalesceAndEnqueue
   * stores dummy operation/payload.  Call this after enqueue to update them.
   */
  setEventDetails(
    peerId: string,
    eventId: string,
    operation: string,
    payloadJsonb: Record<string, unknown>,
  ): void {
    const row = this.rows.get(rowKey(peerId, eventId));
    if (row) {
      row.operation = operation;
      row.payloadJsonb = payloadJsonb;
    }
  }

  async getPendingEvents(peerId: string, limit: number): Promise<PendingEventRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.peerId === peerId && r.status === "pending")
      .sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime())
      .slice(0, limit);
  }

  async markSent(peerId: string, eventIds: string[]): Promise<void> {
    for (const eventId of eventIds) {
      const row = this.rows.get(rowKey(peerId, eventId));
      if (row) {
        row.status = "sent";
        this.entityIndex.delete(entityIndexKey(peerId, row.entityKind, row.entityId));
      }
    }
  }

  async recordRetryFailure(peerId: string, eventIds: string[]): Promise<void> {
    const now = new Date();
    for (const eventId of eventIds) {
      const row = this.rows.get(rowKey(peerId, eventId));
      if (row) {
        row.retryCount += 1;
        row.lastRetryAt = now;
      }
    }
  }

  async deleteExpiredRows(cutoffDate: Date): Promise<Set<string>> {
    const affected = new Set<string>();
    for (const [key, row] of this.rows) {
      if (row.status === "pending" && row.enqueuedAt < cutoffDate) {
        this.entityIndex.delete(entityIndexKey(row.peerId, row.entityKind, row.entityId));
        this.rows.delete(key);
        affected.add(row.peerId);
      }
    }
    return affected;
  }

  async countPending(peerId: string): Promise<number> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.peerId === peerId && row.status === "pending") {
        count += 1;
      }
    }
    return count;
  }

  async oldestPendingEnqueuedAt(peerId: string): Promise<Date | null> {
    let oldest: Date | null = null;
    for (const row of this.rows.values()) {
      if (row.peerId === peerId && row.status === "pending") {
        if (!oldest || row.enqueuedAt < oldest) {
          oldest = row.enqueuedAt;
        }
      }
    }
    return oldest;
  }

  /** All rows (for test assertions). */
  allRows(): PendingEventRow[] {
    return [...this.rows.values()];
  }

  /** Reset all state (call in beforeEach). */
  reset(): void {
    this.rows.clear();
    this.entityIndex.clear();
  }
}

// ─── Internal key helpers ─────────────────────────────────────────────────────

function rowKey(peerId: string, eventId: string): string {
  return `${peerId}::${eventId}`;
}

function entityIndexKey(peerId: string, entityKind: string, entityId: string): string {
  return `${peerId}::${entityKind}::${entityId}`;
}

// ─── Integration helpers ──────────────────────────────────────────────────────

/**
 * Build a `SendEventFn` that delegates to the given federation send primitive.
 *
 * The caller supplies a `sendRaw` function that mimics the transport layer —
 * returns `true` when delivery is confirmed, `false`/throws when the peer
 * is unreachable.
 */
export function makeSendEventFn(
  sendRaw: (
    peerId: string,
    type: string,
    payload: unknown,
  ) => Promise<boolean>,
): SendEventFn {
  return async (peerId, eventId, entityKind, entityId, operation, payloadJsonb) => {
    return sendRaw(peerId, "config:event", {
      eventId,
      entityKind,
      entityId,
      operation,
      payload: payloadJsonb,
    });
  };
}

/**
 * Convenience: generate a stable event ID for tests.
 * Production code uses the outbox row id (UUID).
 */
export function newEventId(): string {
  return crypto.randomUUID();
}
