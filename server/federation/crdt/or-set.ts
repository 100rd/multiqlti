/**
 * OR-Set (Observed-Remove Set) CRDT
 *
 * An OR-Set allows elements to be added and removed without conflicts. Each
 * add operation attaches a unique tag to the element. A remove operation
 * removes all tags currently observed for that element. An element is in
 * the set if and only if it has at least one tag that has not been removed.
 *
 * This resolves the classic add-remove conflict: if node A adds element X
 * while node B removes X concurrently, the merged result contains X (add wins
 * over concurrent remove).
 *
 * Properties:
 *   - Commutative, associative, idempotent
 *
 * Type parameter T must be JSON-serializable and equality-comparable via
 * JSON.stringify (i.e., primitives or stable-key objects work best).
 */

import crypto from "crypto";

/** Each unique add operation is represented by a tag (UUID). */
export interface ORSetState<T> {
  type: "or-set";
  /** Map from serialized element → set of unique add-tags. */
  entries: Record<string, string[]>;
  /** Set of tags that have been tombstoned (removed). */
  tombstones: string[];
}

export class ORSet<T> {
  /** key(element) → Set<tag> */
  private entries = new Map<string, Set<string>>();
  /** Tags that have been explicitly removed. */
  private tombstones = new Set<string>();

  constructor(private nodeId: string) {}

  /** Serialize element to a stable string key. */
  private key(element: T): string {
    return JSON.stringify(element);
  }

  /** Add an element to the set with a fresh unique tag. */
  add(element: T): void {
    const k = this.key(element);
    const tag = `${this.nodeId}:${crypto.randomUUID()}`;
    let tags = this.entries.get(k);
    if (!tags) {
      tags = new Set();
      this.entries.set(k, tags);
    }
    tags.add(tag);
  }

  /**
   * Remove an element from the set by tombstoning all currently observed tags.
   * Concurrent adds that arrive later (with new tags) will still be visible.
   */
  remove(element: T): void {
    const k = this.key(element);
    const tags = this.entries.get(k);
    if (!tags) return;
    for (const tag of tags) {
      this.tombstones.add(tag);
    }
    this.entries.delete(k);
  }

  /** Check membership: element is present if it has at least one live tag. */
  has(element: T): boolean {
    const k = this.key(element);
    const tags = this.entries.get(k);
    if (!tags || tags.size === 0) return false;
    for (const tag of tags) {
      if (!this.tombstones.has(tag)) return true;
    }
    return false;
  }

  /** Current set of live elements. */
  value(): T[] {
    const result: T[] = [];
    for (const [k, tags] of this.entries) {
      const hasLive = Array.from(tags).some((t) => !this.tombstones.has(t));
      if (hasLive) {
        result.push(JSON.parse(k) as T);
      }
    }
    return result;
  }

  /**
   * Merge a remote OR-Set state into this one.
   * Union the add-tags and tombstones, then apply tombstones to entries.
   */
  merge(remote: ORSetState<T>): void {
    // Import tombstones first
    for (const tag of remote.tombstones) {
      this.tombstones.add(tag);
    }

    // Merge entries
    for (const [k, remoteTags] of Object.entries(remote.entries)) {
      let localTags = this.entries.get(k);
      if (!localTags) {
        localTags = new Set();
        this.entries.set(k, localTags);
      }
      for (const tag of remoteTags) {
        localTags.add(tag);
      }
    }

    // Clean up fully-tombstoned entries for memory efficiency
    for (const [k, tags] of this.entries) {
      const allTombstoned = Array.from(tags).every((t) => this.tombstones.has(t));
      if (allTombstoned) {
        this.entries.delete(k);
      }
    }
  }

  /** Serialize to transportable JSON state. */
  toState(): ORSetState<T> {
    const entries: Record<string, string[]> = {};
    for (const [k, tags] of this.entries) {
      const liveTags = Array.from(tags).filter((t) => !this.tombstones.has(t));
      if (liveTags.length > 0) {
        entries[k] = liveTags;
      }
    }
    return {
      type: "or-set",
      entries,
      tombstones: Array.from(this.tombstones),
    };
  }

  /** Deserialize from JSON state. */
  static fromState<T>(nodeId: string, state: ORSetState<T>): ORSet<T> {
    const set = new ORSet<T>(nodeId);
    for (const tag of state.tombstones) {
      set.tombstones.add(tag);
    }
    for (const [k, tags] of Object.entries(state.entries)) {
      set.entries.set(k, new Set(tags));
    }
    return set;
  }
}
