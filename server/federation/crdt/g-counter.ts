/**
 * G-Counter (Grow-only Counter) CRDT
 *
 * A G-Counter is a counter that can only be incremented. Each node in the
 * distributed system maintains its own counter slot. The merged value is the
 * sum of the maximum observed value for each node.
 *
 * Properties:
 *   - Commutative: merge(A, B) == merge(B, A)
 *   - Associative: merge(merge(A, B), C) == merge(A, merge(B, C))
 *   - Idempotent: merge(A, A) == A
 */

export interface GCounterState {
  type: "g-counter";
  counters: Record<string, number>;
}

export class GCounter {
  private counters: Map<string, number>;

  constructor(nodeId: string, counters?: Record<string, number>) {
    this.counters = new Map(Object.entries(counters ?? {}));
    // Ensure this node exists in the map even if at zero
    if (!this.counters.has(nodeId)) {
      this.counters.set(nodeId, 0);
    }
    this._nodeId = nodeId;
  }

  private _nodeId: string;

  /** Increment this node's counter by delta (default 1). */
  increment(delta = 1): void {
    if (delta <= 0) throw new RangeError("GCounter delta must be positive");
    const current = this.counters.get(this._nodeId) ?? 0;
    this.counters.set(this._nodeId, current + delta);
  }

  /** Current total value across all nodes. */
  value(): number {
    let total = 0;
    for (const v of this.counters.values()) {
      total += v;
    }
    return total;
  }

  /**
   * Merge a remote G-Counter state into this one.
   * Takes the per-node maximum, making the operation idempotent.
   */
  merge(remote: GCounterState): void {
    for (const [nodeId, remoteCount] of Object.entries(remote.counters)) {
      const local = this.counters.get(nodeId) ?? 0;
      if (remoteCount > local) {
        this.counters.set(nodeId, remoteCount);
      }
    }
  }

  /** Serialize to transportable JSON state. */
  toState(): GCounterState {
    return {
      type: "g-counter",
      counters: Object.fromEntries(this.counters),
    };
  }

  /** Deserialize from JSON state. */
  static fromState(nodeId: string, state: GCounterState): GCounter {
    return new GCounter(nodeId, state.counters);
  }
}
