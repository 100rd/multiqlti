/**
 * Vector Clock for causal ordering of events across distributed nodes.
 *
 * Each node maintains a counter. When a node sends a message it increments its
 * own counter. When it receives a message it takes the component-wise maximum
 * and then increments its own counter.
 *
 * Causality relations:
 *   A < B (A happened-before B): A[i] <= B[i] for all i, and A[j] < B[j] for some j
 *   A == B (concurrent): neither A < B nor B < A
 */

export interface VectorClockState {
  clocks: Record<string, number>;
}

export type CausalRelation = "before" | "after" | "concurrent" | "equal";

export class VectorClock {
  private clocks: Map<string, number>;

  constructor(private nodeId: string, clocks?: Record<string, number>) {
    this.clocks = new Map(Object.entries(clocks ?? {}));
    if (!this.clocks.has(nodeId)) {
      this.clocks.set(nodeId, 0);
    }
  }

  /** Increment this node's clock (called before sending a message). */
  tick(): void {
    const current = this.clocks.get(this.nodeId) ?? 0;
    this.clocks.set(this.nodeId, current + 1);
  }

  /** Merge a remote clock and then tick (called on receiving a message). */
  receive(remote: VectorClockState): void {
    this.merge(remote);
    this.tick();
  }

  /**
   * Merge (component-wise maximum) without ticking.
   * Used for read-only state synchronisation.
   */
  merge(remote: VectorClockState): void {
    for (const [nodeId, remoteCount] of Object.entries(remote.clocks)) {
      const local = this.clocks.get(nodeId) ?? 0;
      if (remoteCount > local) {
        this.clocks.set(nodeId, remoteCount);
      }
    }
  }

  /** Get the current counter for a node (0 if unseen). */
  get(nodeId: string): number {
    return this.clocks.get(nodeId) ?? 0;
  }

  /** This clock's current counter. */
  currentTick(): number {
    return this.clocks.get(this.nodeId) ?? 0;
  }

  /**
   * Determine the causal relationship between this clock and another.
   */
  compare(other: VectorClockState): CausalRelation {
    const allKeys = new Set([
      ...this.clocks.keys(),
      ...Object.keys(other.clocks),
    ]);

    let thisLessOnSome = false;
    let otherLessOnSome = false;

    for (const k of allKeys) {
      const a = this.clocks.get(k) ?? 0;
      const b = other.clocks[k] ?? 0;
      if (a < b) thisLessOnSome = true;
      if (a > b) otherLessOnSome = true;
    }

    if (!thisLessOnSome && !otherLessOnSome) return "equal";
    if (!otherLessOnSome) return "before"; // this <= other on all dims
    if (!thisLessOnSome) return "after";   // this >= other on all dims
    return "concurrent";
  }

  /** True if this clock is strictly before (causally precedes) other. */
  isBefore(other: VectorClockState): boolean {
    return this.compare(other) === "before";
  }

  /** True if this clock is concurrent with other (no causal order). */
  isConcurrent(other: VectorClockState): boolean {
    return this.compare(other) === "concurrent";
  }

  /** Serialize to transportable JSON state. */
  toState(): VectorClockState {
    return { clocks: Object.fromEntries(this.clocks) };
  }

  /** Deserialize from JSON state. */
  static fromState(nodeId: string, state: VectorClockState): VectorClock {
    return new VectorClock(nodeId, state.clocks);
  }
}
