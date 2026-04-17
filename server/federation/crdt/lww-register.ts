/**
 * LWW-Register (Last-Writer-Wins Register) CRDT
 *
 * Stores a single value tagged with a logical timestamp. On merge, the
 * value with the highest timestamp wins. Ties are broken deterministically
 * by node ID to ensure all replicas converge to the same value.
 *
 * Properties:
 *   - Commutative, associative, idempotent
 *
 * Type parameter T must be JSON-serializable.
 */

export interface LWWRegisterState<T> {
  type: "lww-register";
  value: T | null;
  timestamp: number;
  nodeId: string;
}

export class LWWRegister<T> {
  private _value: T | null;
  private _timestamp: number;
  private _nodeId: string;

  constructor(nodeId: string, value: T | null = null, timestamp = 0) {
    this._nodeId = nodeId;
    this._value = value;
    this._timestamp = timestamp;
  }

  /** Set the value at the current logical time. */
  set(value: T, timestamp?: number): void {
    const ts = timestamp ?? Date.now();
    // Only update if the new timestamp is strictly greater, or if equal and
    // nodeId comparison breaks the tie.
    if (ts > this._timestamp || (ts === this._timestamp && this._nodeId >= this._nodeId)) {
      this._value = value;
      this._timestamp = ts;
    }
  }

  /** Current resolved value (null if never set). */
  value(): T | null {
    return this._value;
  }

  /** Current logical timestamp of the stored value. */
  timestamp(): number {
    return this._timestamp;
  }

  /**
   * Merge a remote LWW-Register state into this one.
   * The entry with the highest timestamp wins; ties broken by nodeId lexicographic order.
   */
  merge(remote: LWWRegisterState<T>): void {
    if (
      remote.timestamp > this._timestamp ||
      (remote.timestamp === this._timestamp && remote.nodeId > this._nodeId)
    ) {
      this._value = remote.value;
      this._timestamp = remote.timestamp;
      this._nodeId = remote.nodeId;
    }
  }

  /** Serialize to transportable JSON state. */
  toState(): LWWRegisterState<T> {
    return {
      type: "lww-register",
      value: this._value,
      timestamp: this._timestamp,
      nodeId: this._nodeId,
    };
  }

  /** Deserialize from JSON state. */
  static fromState<T>(nodeId: string, state: LWWRegisterState<T>): LWWRegister<T> {
    return new LWWRegister<T>(nodeId, state.value, state.timestamp);
  }
}
