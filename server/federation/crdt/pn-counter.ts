/**
 * PN-Counter (Positive-Negative Counter) CRDT
 *
 * A PN-Counter supports both increment and decrement by composing two
 * G-Counters: one for increments (P) and one for decrements (N).
 * The resolved value is P.value() - N.value().
 *
 * Properties:
 *   - Commutative, associative, idempotent (inherited from G-Counter)
 */

import { GCounter, type GCounterState } from "./g-counter.js";

export interface PNCounterState {
  type: "pn-counter";
  positive: GCounterState;
  negative: GCounterState;
}

export class PNCounter {
  private positive: GCounter;
  private negative: GCounter;

  constructor(private nodeId: string, state?: { positive?: Record<string, number>; negative?: Record<string, number> }) {
    this.positive = new GCounter(nodeId, state?.positive ?? {});
    this.negative = new GCounter(nodeId, state?.negative ?? {});
  }

  /** Increment the counter by delta (default 1). */
  increment(delta = 1): void {
    if (delta <= 0) throw new RangeError("PNCounter increment delta must be positive");
    this.positive.increment(delta);
  }

  /** Decrement the counter by delta (default 1). */
  decrement(delta = 1): void {
    if (delta <= 0) throw new RangeError("PNCounter decrement delta must be positive");
    this.negative.increment(delta);
  }

  /** Current resolved value (may be negative). */
  value(): number {
    return this.positive.value() - this.negative.value();
  }

  /**
   * Merge a remote PN-Counter state into this one.
   * Merges each component G-Counter independently.
   */
  merge(remote: PNCounterState): void {
    this.positive.merge(remote.positive);
    this.negative.merge(remote.negative);
  }

  /** Serialize to transportable JSON state. */
  toState(): PNCounterState {
    return {
      type: "pn-counter",
      positive: this.positive.toState(),
      negative: this.negative.toState(),
    };
  }

  /** Deserialize from JSON state. */
  static fromState(nodeId: string, state: PNCounterState): PNCounter {
    return new PNCounter(nodeId, {
      positive: state.positive.counters,
      negative: state.negative.counters,
    });
  }
}
