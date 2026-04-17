/**
 * Tests for CRDT-based P2P collaboration (issue #230)
 *
 * Covers:
 *   - G-Counter: merge commutativity, associativity, idempotency, serialisation
 *   - PN-Counter: same properties + decrement
 *   - LWW-Register: LWW semantics, tie-breaking, serialisation
 *   - OR-Set: add/remove without conflict, concurrent adds, serialisation
 *   - LWW-Map: per-key LWW, merge, serialisation
 *   - VectorClock: tick, merge, compare (before/after/concurrent/equal)
 *   - CRDTDocument: compound merge, session mismatch guard, snapshot
 *   - CRDTSyncManager: state-based sync, delta mode, anti-entropy, peer clocks
 *   - CRDTPeerSyncService: mode switching, push/receive, peer versions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GCounter } from "../../server/federation/crdt/g-counter";
import { PNCounter } from "../../server/federation/crdt/pn-counter";
import { LWWRegister } from "../../server/federation/crdt/lww-register";
import { ORSet } from "../../server/federation/crdt/or-set";
import { LWWMap } from "../../server/federation/crdt/lww-map";
import { VectorClock } from "../../server/federation/crdt/vector-clock";
import { CRDTDocument } from "../../server/federation/crdt/document";
import { CRDTSyncManager } from "../../server/federation/crdt/sync";
import { CRDTPeerSyncService } from "../../server/federation/crdt/peer-sync";
import type { FederationManager } from "../../server/federation/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFederationManager(peers: string[] = []): FederationManager {
  return {
    on: vi.fn(),
    send: vi.fn(),
    getPeers: vi.fn(() => peers.map((p) => ({ instanceId: p }))),
    isEnabled: vi.fn(() => true),
  } as unknown as FederationManager;
}

// ─── G-Counter ───────────────────────────────────────────────────────────────

describe("GCounter", () => {
  it("increments correctly", () => {
    const c = new GCounter("A");
    c.increment();
    c.increment(3);
    expect(c.value()).toBe(4);
  });

  it("rejects non-positive delta", () => {
    const c = new GCounter("A");
    expect(() => c.increment(0)).toThrow(RangeError);
    expect(() => c.increment(-1)).toThrow(RangeError);
  });

  it("merge is commutative", () => {
    const a = new GCounter("A");
    const b = new GCounter("B");
    a.increment(2);
    b.increment(3);

    const aState = a.toState();
    const bState = b.toState();

    const left = new GCounter("C");
    left.merge(aState);
    left.merge(bState);

    const right = new GCounter("C");
    right.merge(bState);
    right.merge(aState);

    expect(left.value()).toBe(right.value());
    expect(left.value()).toBe(5);
  });

  it("merge is associative", () => {
    const a = new GCounter("A");
    const b = new GCounter("B");
    const c = new GCounter("C");
    a.increment(1);
    b.increment(2);
    c.increment(3);

    // (A ∪ B) ∪ C
    const left = GCounter.fromState("X", a.toState());
    left.merge(b.toState());
    left.merge(c.toState());

    // A ∪ (B ∪ C)
    const bc = GCounter.fromState("Y", b.toState());
    bc.merge(c.toState());
    const right = GCounter.fromState("Z", a.toState());
    right.merge(bc.toState());

    expect(left.value()).toBe(right.value());
    expect(left.value()).toBe(6);
  });

  it("merge is idempotent", () => {
    const a = new GCounter("A");
    a.increment(5);
    const state = a.toState();

    const b = GCounter.fromState("B", state);
    b.merge(state);
    b.merge(state);

    expect(b.value()).toBe(5);
  });

  it("serialisation round-trips", () => {
    const a = new GCounter("A");
    a.increment(7);
    const state = a.toState();
    const b = GCounter.fromState("A", state);
    expect(b.value()).toBe(7);
  });

  it("multi-node merge sums maxima", () => {
    const a = new GCounter("A");
    a.increment(10);

    const b = new GCounter("B");
    b.increment(5);

    const merged = GCounter.fromState("M", a.toState());
    merged.merge(b.toState());

    expect(merged.value()).toBe(15);
  });
});

// ─── PN-Counter ──────────────────────────────────────────────────────────────

describe("PNCounter", () => {
  it("increment and decrement", () => {
    const c = new PNCounter("A");
    c.increment(5);
    c.decrement(2);
    expect(c.value()).toBe(3);
  });

  it("can go negative", () => {
    const c = new PNCounter("A");
    c.decrement(3);
    expect(c.value()).toBe(-3);
  });

  it("rejects non-positive deltas", () => {
    const c = new PNCounter("A");
    expect(() => c.increment(0)).toThrow(RangeError);
    expect(() => c.decrement(-1)).toThrow(RangeError);
  });

  it("merge is commutative", () => {
    const a = new PNCounter("A");
    const b = new PNCounter("B");
    a.increment(10);
    b.decrement(3);

    const aS = a.toState();
    const bS = b.toState();

    const left = new PNCounter("C");
    left.merge(aS);
    left.merge(bS);

    const right = new PNCounter("D");
    right.merge(bS);
    right.merge(aS);

    expect(left.value()).toBe(right.value());
    expect(left.value()).toBe(7);
  });

  it("merge is idempotent", () => {
    const a = new PNCounter("A");
    a.increment(4);
    a.decrement(1);
    const s = a.toState();

    const b = PNCounter.fromState("B", s);
    b.merge(s);
    b.merge(s);

    expect(b.value()).toBe(3);
  });

  it("serialisation round-trips", () => {
    const a = new PNCounter("A");
    a.increment(6);
    a.decrement(2);
    const b = PNCounter.fromState("A", a.toState());
    expect(b.value()).toBe(4);
  });
});

// ─── LWW-Register ─────────────────────────────────────────────────────────────

describe("LWWRegister", () => {
  it("stores a value", () => {
    const r = new LWWRegister<string>("A");
    r.set("hello", 100);
    expect(r.value()).toBe("hello");
  });

  it("higher timestamp wins", () => {
    const r = new LWWRegister<string>("A");
    r.set("first", 100);
    r.set("second", 200);
    expect(r.value()).toBe("second");
  });

  it("lower timestamp does not overwrite", () => {
    const r = new LWWRegister<string>("A");
    r.set("newer", 200);
    r.set("older", 100);
    expect(r.value()).toBe("newer");
  });

  it("merge: remote timestamp higher wins", () => {
    const a = new LWWRegister<string>("A");
    a.set("local", 100);

    const b = new LWWRegister<string>("B");
    b.set("remote", 200);

    a.merge(b.toState());
    expect(a.value()).toBe("remote");
  });

  it("merge: local timestamp higher survives", () => {
    const a = new LWWRegister<string>("A");
    a.set("local", 300);

    const b = new LWWRegister<string>("B");
    b.set("remote", 100);

    a.merge(b.toState());
    expect(a.value()).toBe("local");
  });

  it("merge tie-breaking by nodeId", () => {
    const a = new LWWRegister<string>("A");
    a.set("from-A", 100);

    const b = new LWWRegister<string>("B");
    b.set("from-B", 100);

    // "B" > "A" lexicographically
    const merged = new LWWRegister<string>("A");
    merged.merge(a.toState());
    merged.merge(b.toState());
    expect(merged.value()).toBe("from-B");
  });

  it("merge is commutative", () => {
    const a = new LWWRegister<number>("A");
    a.set(1, 50);
    const b = new LWWRegister<number>("B");
    b.set(2, 100);

    const left = new LWWRegister<number>("C");
    left.merge(a.toState());
    left.merge(b.toState());

    const right = new LWWRegister<number>("D");
    right.merge(b.toState());
    right.merge(a.toState());

    expect(left.value()).toBe(right.value());
  });

  it("merge is idempotent", () => {
    const a = new LWWRegister<string>("A");
    a.set("x", 100);
    const s = a.toState();

    const b = LWWRegister.fromState("B", s);
    b.merge(s);
    b.merge(s);

    expect(b.value()).toBe("x");
  });

  it("serialisation round-trips", () => {
    const a = new LWWRegister<Record<string, number>>("A");
    a.set({ count: 42 }, 999);
    const b = LWWRegister.fromState<Record<string, number>>("A", a.toState());
    expect(b.value()).toEqual({ count: 42 });
    expect(b.timestamp()).toBe(999);
  });
});

// ─── OR-Set ───────────────────────────────────────────────────────────────────

describe("ORSet", () => {
  it("add and has", () => {
    const s = new ORSet<string>("A");
    s.add("alice");
    expect(s.has("alice")).toBe(true);
    expect(s.has("bob")).toBe(false);
  });

  it("remove after add", () => {
    const s = new ORSet<string>("A");
    s.add("alice");
    s.remove("alice");
    expect(s.has("alice")).toBe(false);
    expect(s.value()).not.toContain("alice");
  });

  it("remove on non-existent element is a no-op", () => {
    const s = new ORSet<string>("A");
    s.remove("ghost");
    expect(s.value()).toHaveLength(0);
  });

  it("add after remove wins over the remove (concurrent add wins)", () => {
    const a = new ORSet<string>("A");
    const b = new ORSet<string>("B");

    a.add("x");

    // B removes the element it knew about
    const beforeRemove = a.toState();
    b.merge(beforeRemove);
    b.remove("x");

    // A concurrently adds "x" again with a new tag
    a.remove("x");
    a.add("x");

    // Merge B's state into A
    a.merge(b.toState());

    // A's new add was concurrent with B's remove — new tag survives
    expect(a.has("x")).toBe(true);
  });

  it("merge is commutative", () => {
    const a = new ORSet<string>("A");
    const b = new ORSet<string>("B");
    a.add("foo");
    b.add("bar");

    const left = new ORSet<string>("C");
    left.merge(a.toState());
    left.merge(b.toState());

    const right = new ORSet<string>("D");
    right.merge(b.toState());
    right.merge(a.toState());

    expect(left.value().sort()).toEqual(right.value().sort());
  });

  it("merge is associative", () => {
    const a = new ORSet<string>("A");
    const b = new ORSet<string>("B");
    const c = new ORSet<string>("C");
    a.add("1");
    b.add("2");
    c.add("3");

    const left = new ORSet<string>("X");
    left.merge(a.toState());
    left.merge(b.toState());
    left.merge(c.toState());

    const bc = new ORSet<string>("BC");
    bc.merge(b.toState());
    bc.merge(c.toState());

    const right = new ORSet<string>("Y");
    right.merge(a.toState());
    right.merge(bc.toState());

    expect(left.value().sort()).toEqual(right.value().sort());
  });

  it("merge is idempotent", () => {
    const a = new ORSet<string>("A");
    a.add("item");
    const s = a.toState();

    const b = ORSet.fromState<string>("B", s);
    b.merge(s);
    b.merge(s);

    expect(b.value()).toHaveLength(1);
    expect(b.value()).toContain("item");
  });

  it("serialisation round-trips", () => {
    const a = new ORSet<string>("A");
    a.add("alice");
    a.add("bob");
    a.remove("alice");

    const b = ORSet.fromState<string>("B", a.toState());
    expect(b.has("alice")).toBe(false);
    expect(b.has("bob")).toBe(true);
  });

  it("works with non-string types", () => {
    const s = new ORSet<number>("A");
    s.add(1);
    s.add(2);
    s.remove(1);
    expect(s.value()).toEqual([2]);
  });
});

// ─── LWW-Map ──────────────────────────────────────────────────────────────────

describe("LWWMap", () => {
  it("set and get", () => {
    const m = new LWWMap<string, string>("A");
    m.set("k1", "v1", 100);
    expect(m.get("k1")).toBe("v1");
  });

  it("higher timestamp wins per key", () => {
    const m = new LWWMap<string, string>("A");
    m.set("k", "old", 100);
    m.set("k", "new", 200);
    expect(m.get("k")).toBe("new");
  });

  it("merge: picks maximum per key", () => {
    const a = new LWWMap<string, string>("A");
    const b = new LWWMap<string, string>("B");
    a.set("k1", "a-value", 100);
    b.set("k1", "b-value", 200);
    b.set("k2", "only-b", 50);

    a.merge(b.toState());

    expect(a.get("k1")).toBe("b-value");
    expect(a.get("k2")).toBe("only-b");
  });

  it("merge is commutative", () => {
    const a = new LWWMap<string, number>("A");
    const b = new LWWMap<string, number>("B");
    a.set("x", 1, 100);
    b.set("x", 2, 200);

    const left = new LWWMap<string, number>("C");
    left.merge(a.toState());
    left.merge(b.toState());

    const right = new LWWMap<string, number>("D");
    right.merge(b.toState());
    right.merge(a.toState());

    expect(left.get("x")).toBe(right.get("x"));
  });

  it("merge is idempotent", () => {
    const a = new LWWMap<string, string>("A");
    a.set("k", "val", 100);
    const s = a.toState();

    const b = LWWMap.fromState<string, string>("B", s);
    b.merge(s);
    b.merge(s);

    expect(b.get("k")).toBe("val");
  });

  it("serialisation round-trips", () => {
    const a = new LWWMap<string, string>("A");
    a.set("foo", "bar", 42);
    const b = LWWMap.fromState<string, string>("A", a.toState());
    expect(b.get("foo")).toBe("bar");
  });

  it("value() returns all keys", () => {
    const m = new LWWMap<string, string>("A");
    m.set("a", "1", 1);
    m.set("b", "2", 2);
    const v = m.value();
    expect(v["a"]).toBe("1");
    expect(v["b"]).toBe("2");
  });
});

// ─── VectorClock ─────────────────────────────────────────────────────────────

describe("VectorClock", () => {
  it("tick increments this node", () => {
    const vc = new VectorClock("A");
    vc.tick();
    vc.tick();
    expect(vc.currentTick()).toBe(2);
  });

  it("merge takes component-wise maximum", () => {
    const a = new VectorClock("A");
    a.tick();
    a.tick();

    const b = new VectorClock("B");
    b.tick();

    a.merge(b.toState());
    expect(a.get("A")).toBe(2);
    expect(a.get("B")).toBe(1);
  });

  it("receive merges and ticks", () => {
    const a = new VectorClock("A");
    a.tick();

    const b = new VectorClock("B");
    b.tick();

    a.receive(b.toState());
    expect(a.get("A")).toBe(2); // incremented from 1 after merge
    expect(a.get("B")).toBe(1); // from remote
  });

  it("compare: equal", () => {
    const a = new VectorClock("A");
    const b = new VectorClock("A");
    expect(a.compare(b.toState())).toBe("equal");
  });

  it("compare: before", () => {
    const a = new VectorClock("A");
    a.tick();

    const b = new VectorClock("A");
    b.tick();
    b.tick();

    expect(a.compare(b.toState())).toBe("before");
    expect(a.isBefore(b.toState())).toBe(true);
  });

  it("compare: after", () => {
    const a = new VectorClock("A");
    a.tick();
    a.tick();

    const b = new VectorClock("A");
    b.tick();

    expect(a.compare(b.toState())).toBe("after");
  });

  it("compare: concurrent", () => {
    const a = new VectorClock("A");
    a.tick();

    const b = new VectorClock("B");
    b.tick();

    expect(a.compare(b.toState())).toBe("concurrent");
    expect(a.isConcurrent(b.toState())).toBe(true);
  });

  it("serialisation round-trips", () => {
    const a = new VectorClock("A");
    a.tick();
    a.tick();
    const b = VectorClock.fromState("A", a.toState());
    expect(b.currentTick()).toBe(2);
  });
});

// ─── CRDTDocument ─────────────────────────────────────────────────────────────

describe("CRDTDocument", () => {
  it("merges participants from two nodes", () => {
    const docA = new CRDTDocument("session-1", "A");
    const docB = new CRDTDocument("session-1", "B");

    docA.participants.add("alice");
    docB.participants.add("bob");

    docA.merge(docB.toState());

    expect(docA.participants.has("alice")).toBe(true);
    expect(docA.participants.has("bob")).toBe(true);
  });

  it("merges stageOutputs with LWW semantics", () => {
    const docA = new CRDTDocument("session-1", "A");
    const docB = new CRDTDocument("session-1", "B");

    docA.stageOutputs.set("stage-1", "output-A", 100);
    docB.stageOutputs.set("stage-1", "output-B", 200);

    docA.merge(docB.toState());
    expect(docA.stageOutputs.get("stage-1")).toBe("output-B");
  });

  it("merges votes (G-Counter)", () => {
    const docA = new CRDTDocument("session-1", "A");
    const docB = new CRDTDocument("session-1", "B");

    docA.votes.increment(3);
    docB.votes.increment(2);

    docA.merge(docB.toState());
    expect(docA.votes.value()).toBe(5);
  });

  it("merges tags (OR-Set)", () => {
    const docA = new CRDTDocument("session-1", "A");
    const docB = new CRDTDocument("session-1", "B");

    docA.tags.add("urgent");
    docB.tags.add("beta");

    docA.merge(docB.toState());
    expect(docA.tags.value()).toContain("urgent");
    expect(docA.tags.value()).toContain("beta");
  });

  it("merge updates vectorClock", () => {
    const docA = new CRDTDocument("session-1", "A");
    const docB = new CRDTDocument("session-1", "B");

    docA.vectorClock.tick();
    docB.vectorClock.tick();
    docB.vectorClock.tick();

    docA.merge(docB.toState());
    expect(docA.vectorClock.get("B")).toBe(2);
  });

  it("rejects merge from a different session", () => {
    const docA = new CRDTDocument("session-1", "A");
    const docB = new CRDTDocument("session-2", "B");

    expect(() => docA.merge(docB.toState())).toThrow(/Cannot merge.*session/);
  });

  it("serialisation round-trips via fromState", () => {
    const doc = new CRDTDocument("session-1", "A");
    doc.participants.add("alice");
    doc.stageOutputs.set("s1", "out", 100);
    doc.votes.increment(5);
    doc.tags.add("review");

    const restored = CRDTDocument.fromState(doc.toState());
    expect(restored.participants.has("alice")).toBe(true);
    expect(restored.stageOutputs.get("s1")).toBe("out");
    expect(restored.votes.value()).toBe(5);
    expect(restored.tags.has("review")).toBe(true);
  });

  it("snapshot returns resolved values", () => {
    const doc = new CRDTDocument("session-1", "A");
    doc.participants.add("alice");
    doc.votes.increment(7);

    const snap = doc.snapshot();
    expect(snap.participants).toContain("alice");
    expect(snap.votes).toBe(7);
  });

  it("concurrent modifications from 3 peers converge", () => {
    const a = new CRDTDocument("session-1", "A");
    const b = new CRDTDocument("session-1", "B");
    const c = new CRDTDocument("session-1", "C");

    // All three peers independently modify the document
    a.participants.add("alice");
    b.participants.add("bob");
    c.participants.add("charlie");
    a.votes.increment(1);
    b.votes.increment(2);
    c.votes.increment(3);

    // Simulate full gossip
    a.merge(b.toState());
    a.merge(c.toState());
    b.merge(a.toState());
    b.merge(c.toState());
    c.merge(a.toState());
    c.merge(b.toState());

    // All replicas should converge
    expect(a.participants.value().sort()).toEqual(["alice", "bob", "charlie"]);
    expect(b.participants.value().sort()).toEqual(["alice", "bob", "charlie"]);
    expect(c.participants.value().sort()).toEqual(["alice", "bob", "charlie"]);
    expect(a.votes.value()).toBe(6);
    expect(b.votes.value()).toBe(6);
    expect(c.votes.value()).toBe(6);
  });
});

// ─── CRDTSyncManager ─────────────────────────────────────────────────────────

describe("CRDTSyncManager", () => {
  it("push calls sendFn with correct delta", () => {
    const sent: Array<{ peerId: string; payload: unknown }> = [];
    const sendFn = vi.fn((peerId: string, delta: unknown) => {
      sent.push({ peerId, payload: delta });
    });

    const mgr = new CRDTSyncManager("A", sendFn);
    const doc = new CRDTDocument("s1", "A");
    doc.participants.add("alice");
    mgr.registerDocument(doc);

    mgr.push("s1", "peer-B");

    expect(sendFn).toHaveBeenCalledOnce();
    const delta = sent[0].payload as { sessionId: string; fromNodeId: string };
    expect(delta.sessionId).toBe("s1");
    expect(delta.fromNodeId).toBe("A");
    expect(sent[0].peerId).toBe("peer-B");
  });

  it("receive merges and returns true when document changes", () => {
    const sendFn = vi.fn();
    const mgrA = new CRDTSyncManager("A", sendFn);
    const mgrB = new CRDTSyncManager("B", vi.fn());

    const docA = new CRDTDocument("s1", "A");
    docA.participants.add("alice");
    mgrA.registerDocument(docA);

    const docB = new CRDTDocument("s1", "B");
    mgrB.registerDocument(docB);

    const delta = {
      sessionId: "s1",
      fromNodeId: "A",
      senderClock: docA.vectorClock.toState(),
      sinceRecipientClock: null,
      state: docA.toState(),
    };

    const changed = mgrB.receive(delta);
    expect(changed).toBe(true);
    expect(mgrB.getDocument("s1")!.participants.has("alice")).toBe(true);
  });

  it("receive returns false when already up-to-date", () => {
    const sendFn = vi.fn();
    const mgrA = new CRDTSyncManager("A", sendFn);
    const mgrB = new CRDTSyncManager("B", vi.fn());

    const docA = new CRDTDocument("s1", "A");
    docA.vectorClock.tick();
    mgrA.registerDocument(docA);

    const docB = new CRDTDocument("s1", "B");
    docB.vectorClock.tick();
    docB.vectorClock.tick();
    mgrB.registerDocument(docB);

    const delta = {
      sessionId: "s1",
      fromNodeId: "A",
      senderClock: docA.vectorClock.toState(),
      sinceRecipientClock: null,
      state: docA.toState(),
    };

    // Simulate B having already merged A's tick
    docB.vectorClock.merge(docA.vectorClock.toState());

    // Now B's clock dominates A's — should skip merge
    const changed = mgrB.receive(delta);
    expect(changed).toBe(false);
  });

  it("receive bootstraps a new document from incoming state", () => {
    const mgrB = new CRDTSyncManager("B", vi.fn());

    const docA = new CRDTDocument("s1", "A");
    docA.participants.add("alice");

    const delta = {
      sessionId: "s1",
      fromNodeId: "A",
      senderClock: docA.vectorClock.toState(),
      sinceRecipientClock: null,
      state: docA.toState(),
    };

    mgrB.receive(delta);
    const doc = mgrB.getDocument("s1");
    expect(doc).toBeDefined();
    expect(doc!.participants.has("alice")).toBe(true);
  });

  it("broadcast calls push for each peer", () => {
    const sendFn = vi.fn();
    const mgr = new CRDTSyncManager("A", sendFn);
    const doc = new CRDTDocument("s1", "A");
    mgr.registerDocument(doc);

    mgr.broadcast("s1", ["B", "C", "D"]);
    expect(sendFn).toHaveBeenCalledTimes(3);
  });

  it("anti-entropy periodically pushes state to all peers", async () => {
    vi.useFakeTimers();

    const sendFn = vi.fn();
    const mgr = new CRDTSyncManager("A", sendFn, {
      antiEntropyIntervalMs: 1000,
    });
    mgr.updatePeerClock("B", { clocks: {} });
    mgr.updatePeerClock("C", { clocks: {} });

    const doc = new CRDTDocument("s1", "A");
    mgr.registerDocument(doc);

    vi.advanceTimersByTime(1100);

    expect(sendFn).toHaveBeenCalledTimes(2); // once per peer

    mgr.stop();
    vi.useRealTimers();
  });

  it("stop prevents further anti-entropy sends", async () => {
    vi.useFakeTimers();

    const sendFn = vi.fn();
    const mgr = new CRDTSyncManager("A", sendFn, {
      antiEntropyIntervalMs: 500,
    });
    mgr.updatePeerClock("B", { clocks: {} });
    const doc = new CRDTDocument("s1", "A");
    mgr.registerDocument(doc);

    mgr.stop();
    vi.advanceTimersByTime(2000);

    expect(sendFn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("peer clock is updated after receive", () => {
    const mgr = new CRDTSyncManager("A", vi.fn());
    const doc = new CRDTDocument("s1", "B");
    doc.vectorClock.tick();

    const delta = {
      sessionId: "s1",
      fromNodeId: "B",
      senderClock: doc.vectorClock.toState(),
      sinceRecipientClock: null,
      state: doc.toState(),
    };

    mgr.receive(delta);
    const peerClock = mgr.getPeerClock("B");
    expect(peerClock).toBeDefined();
    expect(peerClock!.clocks["B"]).toBe(1);
  });
});

// ─── CRDTPeerSyncService ──────────────────────────────────────────────────────

describe("CRDTPeerSyncService", () => {
  let federation: FederationManager;
  let service: CRDTPeerSyncService;

  beforeEach(() => {
    federation = makeFederationManager(["peer-B", "peer-C"]);
    service = new CRDTPeerSyncService(federation, "A", {
      defaultMode: "single_writer",
    });
  });

  it("getOrCreateDocument returns undefined in single_writer mode", () => {
    const doc = service.getOrCreateDocument("s1");
    expect(doc).toBeUndefined();
  });

  it("setSyncMode to crdt_p2p creates a document", () => {
    service.setSyncMode("s1", "crdt_p2p");
    const doc = service.getDocument("s1");
    expect(doc).toBeDefined();
    expect(doc!.sessionId).toBe("s1");
  });

  it("setSyncMode to crdt_p2p triggers push to all peers", () => {
    service.setSyncMode("s1", "crdt_p2p");
    expect(federation.send).toHaveBeenCalledWith(
      "crdt:push",
      expect.objectContaining({ sessionId: "s1" }),
      "peer-B",
    );
    expect(federation.send).toHaveBeenCalledWith(
      "crdt:push",
      expect.objectContaining({ sessionId: "s1" }),
      "peer-C",
    );
  });

  it("getSyncMode returns correct mode", () => {
    expect(service.getSyncMode("s1")).toBe("single_writer");
    service.setSyncMode("s1", "crdt_p2p");
    expect(service.getSyncMode("s1")).toBe("crdt_p2p");
  });

  it("pushToAllPeers does nothing in single_writer mode", () => {
    vi.clearAllMocks();
    service.pushToAllPeers("s1");
    expect(federation.send).not.toHaveBeenCalled();
  });

  it("pushToAllPeers sends to all peers in crdt_p2p mode", () => {
    service.setSyncMode("s1", "crdt_p2p");
    vi.clearAllMocks();
    service.pushToAllPeers("s1");
    expect(federation.send).toHaveBeenCalledTimes(2);
  });

  it("handles crdt:push federation message by merging state", () => {
    service.setSyncMode("s1", "crdt_p2p");

    const remoteDoc = new CRDTDocument("s1", "B");
    remoteDoc.participants.add("bob");

    // Retrieve the handler registered for "crdt:push"
    const calls = (federation.on as ReturnType<typeof vi.fn>).mock.calls;
    const pushHandler = calls.find(([type]: [string]) => type === "crdt:push")?.[1] as
      | ((msg: { payload: unknown; from: string }, peer: unknown) => void)
      | undefined;

    expect(pushHandler).toBeDefined();
    pushHandler!(
      {
        payload: {
          sessionId: "s1",
          fromNodeId: "B",
          senderClock: remoteDoc.vectorClock.toState(),
          sinceRecipientClock: null,
          state: remoteDoc.toState(),
        },
        from: "B",
      },
      {},
    );

    const doc = service.getDocument("s1");
    expect(doc!.participants.has("bob")).toBe(true);
  });

  it("getPeerVersions returns peers with clock info", () => {
    service.setSyncMode("s1", "crdt_p2p");

    const versions = service.getPeerVersions("s1");
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.peerId)).toContain("peer-B");
    expect(versions.map((v) => v.peerId)).toContain("peer-C");
  });

  it("stop does not throw", () => {
    expect(() => service.stop()).not.toThrow();
  });
});

// ─── CRDT API Route tests ─────────────────────────────────────────────────────

import express from "express";
import type { Express } from "express";
import request from "supertest";
import { registerCRDTRoutes } from "../../server/routes/federation";

function buildApp(crdtService: CRDTPeerSyncService | null): Express {
  const app = express();
  app.use(express.json());
  registerCRDTRoutes(app, crdtService);
  return app;
}

describe("CRDT API Routes", () => {
  let federation: FederationManager;
  let service: CRDTPeerSyncService;
  let app: Express;

  beforeEach(() => {
    federation = makeFederationManager(["peer-B"]);
    service = new CRDTPeerSyncService(federation, "A");
    app = buildApp(service);
  });

  afterEach(() => {
    service.stop();
  });

  describe("GET /api/sessions/:id/crdt-state", () => {
    it("returns null state for single_writer session", async () => {
      const res = await request(app).get("/api/sessions/s1/crdt-state");
      expect(res.status).toBe(200);
      expect(res.body.syncMode).toBe("single_writer");
      expect(res.body.state).toBeNull();
    });

    it("returns CRDT document state for crdt_p2p session", async () => {
      service.setSyncMode("s1", "crdt_p2p");
      const res = await request(app).get("/api/sessions/s1/crdt-state");
      expect(res.status).toBe(200);
      expect(res.body.syncMode).toBe("crdt_p2p");
      expect(res.body.state).toBeDefined();
      expect(res.body.value).toBeDefined();
    });

    it("returns 503 when service is unavailable", async () => {
      const nullApp = buildApp(null);
      const res = await request(nullApp).get("/api/sessions/s1/crdt-state");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /api/sessions/:id/crdt-merge", () => {
    it("returns 409 for single_writer session", async () => {
      const remoteDoc = new CRDTDocument("s1", "B");
      const res = await request(app)
        .post("/api/sessions/s1/crdt-merge")
        .send({ state: remoteDoc.toState() });
      expect(res.status).toBe(409);
    });

    it("merges state and returns updated document", async () => {
      service.setSyncMode("s1", "crdt_p2p");

      const remoteDoc = new CRDTDocument("s1", "B");
      remoteDoc.participants.add("bob");
      remoteDoc.votes.increment(3);

      const res = await request(app)
        .post("/api/sessions/s1/crdt-merge")
        .send({ state: remoteDoc.toState() });

      expect(res.status).toBe(200);
      expect(res.body.merged).toBe(true);
      expect(res.body.value.participants).toContain("bob");
      expect(res.body.value.votes).toBe(3);
    });

    it("returns 400 for invalid state", async () => {
      service.setSyncMode("s1", "crdt_p2p");
      const res = await request(app)
        .post("/api/sessions/s1/crdt-merge")
        .send({ state: { bad: true } });
      expect(res.status).toBe(400);
    });

    it("returns 503 when service is unavailable", async () => {
      const nullApp = buildApp(null);
      const remoteDoc = new CRDTDocument("s1", "B");
      const res = await request(nullApp)
        .post("/api/sessions/s1/crdt-merge")
        .send({ state: remoteDoc.toState() });
      expect(res.status).toBe(503);
    });
  });

  describe("GET /api/sessions/:id/crdt-peers", () => {
    it("returns empty array for session with no peers in crdt state", async () => {
      const res = await request(app).get("/api/sessions/s1/crdt-peers");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("returns peer list for active crdt_p2p session", async () => {
      service.setSyncMode("s1", "crdt_p2p");
      const res = await request(app).get("/api/sessions/s1/crdt-peers");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].peerId).toBe("peer-B");
    });

    it("returns 503 when service is unavailable", async () => {
      const nullApp = buildApp(null);
      const res = await request(nullApp).get("/api/sessions/s1/crdt-peers");
      expect(res.status).toBe(503);
    });
  });

  describe("POST /api/sessions/:id/crdt-mode", () => {
    it("switches to crdt_p2p mode", async () => {
      const res = await request(app)
        .post("/api/sessions/s1/crdt-mode")
        .send({ mode: "crdt_p2p" });
      expect(res.status).toBe(200);
      expect(res.body.syncMode).toBe("crdt_p2p");
      expect(res.body.state).toBeDefined();
    });

    it("switches back to single_writer mode", async () => {
      service.setSyncMode("s1", "crdt_p2p");
      const res = await request(app)
        .post("/api/sessions/s1/crdt-mode")
        .send({ mode: "single_writer" });
      expect(res.status).toBe(200);
      expect(res.body.syncMode).toBe("single_writer");
    });

    it("returns 400 for invalid mode", async () => {
      const res = await request(app)
        .post("/api/sessions/s1/crdt-mode")
        .send({ mode: "invalid_mode" });
      expect(res.status).toBe(400);
    });

    it("returns 503 when service is unavailable", async () => {
      const nullApp = buildApp(null);
      const res = await request(nullApp)
        .post("/api/sessions/s1/crdt-mode")
        .send({ mode: "crdt_p2p" });
      expect(res.status).toBe(503);
    });
  });
});
