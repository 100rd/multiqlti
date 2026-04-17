/**
 * LWW-Map (Last-Writer-Wins Map) CRDT
 *
 * A key-value map where each entry is an LWW-Register. Concurrent writes
 * to the same key are resolved by taking the entry with the higher timestamp
 * (ties broken by nodeId lexicographic order).
 *
 * Properties:
 *   - Commutative, associative, idempotent (each register satisfies these)
 *
 * Key must be a string. Value V must be JSON-serializable.
 */

import { LWWRegister, type LWWRegisterState } from "./lww-register.js";

export interface LWWMapState<V> {
  type: "lww-map";
  entries: Record<string, LWWRegisterState<V>>;
}

export class LWWMap<K extends string, V> {
  private entries = new Map<K, LWWRegister<V>>();

  constructor(private nodeId: string) {}

  /** Set a key to value with an optional explicit timestamp. */
  set(key: K, value: V, timestamp?: number): void {
    let reg = this.entries.get(key);
    if (!reg) {
      reg = new LWWRegister<V>(this.nodeId);
      this.entries.set(key, reg);
    }
    reg.set(value, timestamp);
  }

  /** Get the current value for a key (undefined if not set). */
  get(key: K): V | null | undefined {
    return this.entries.get(key)?.value();
  }

  /** Check if a key exists (has been set at least once). */
  has(key: K): boolean {
    return this.entries.has(key) && this.entries.get(key)!.value() !== null;
  }

  /** Get all key-value pairs as a plain object. */
  value(): Record<K, V | null> {
    const result = {} as Record<K, V | null>;
    for (const [k, reg] of this.entries) {
      result[k] = reg.value();
    }
    return result;
  }

  /**
   * Merge a remote LWW-Map state into this one.
   * Each register is merged independently.
   */
  merge(remote: LWWMapState<V>): void {
    for (const [k, remoteState] of Object.entries(remote.entries) as [K, LWWRegisterState<V>][]) {
      let reg = this.entries.get(k);
      if (!reg) {
        reg = new LWWRegister<V>(this.nodeId);
        this.entries.set(k, reg);
      }
      reg.merge(remoteState);
    }
  }

  /** Serialize to transportable JSON state. */
  toState(): LWWMapState<V> {
    const entries: Record<string, LWWRegisterState<V>> = {};
    for (const [k, reg] of this.entries) {
      entries[k] = reg.toState();
    }
    return {
      type: "lww-map",
      entries,
    };
  }

  /** Deserialize from JSON state. */
  static fromState<K extends string, V>(nodeId: string, state: LWWMapState<V>): LWWMap<K, V> {
    const map = new LWWMap<K, V>(nodeId);
    for (const [k, regState] of Object.entries(state.entries) as [K, LWWRegisterState<V>][]) {
      const reg = LWWRegister.fromState<V>(nodeId, regState);
      map.entries.set(k, reg);
    }
    return map;
  }
}
