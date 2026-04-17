/**
 * CRDT Document — compound CRDT representing a shared session's collaborative state.
 *
 * Composes the individual CRDT types into a single unit that can be
 * serialised, sent over the wire, and merged atomically.
 *
 * Fields:
 *   participants   ORSet<string>              — who's in the session
 *   stageOutputs   LWWMap<string, string>     — stageId → output text
 *   stageStatuses  LWWMap<string, string>     — stageId → status string
 *   votes          GCounter                   — total votes cast
 *   tags           ORSet<string>              — session tags
 *   metadata       LWWRegister<object>        — arbitrary session metadata
 *   vectorClock    VectorClock                — causal ordering
 */

import { GCounter, type GCounterState } from "./g-counter.js";
import { LWWRegister, type LWWRegisterState } from "./lww-register.js";
import { LWWMap, type LWWMapState } from "./lww-map.js";
import { ORSet, type ORSetState } from "./or-set.js";
import { VectorClock, type VectorClockState } from "./vector-clock.js";

export interface CRDTDocumentState {
  sessionId: string;
  nodeId: string;
  participants: ORSetState<string>;
  stageOutputs: LWWMapState<string>;
  stageStatuses: LWWMapState<string>;
  votes: GCounterState;
  tags: ORSetState<string>;
  metadata: LWWRegisterState<Record<string, unknown>>;
  vectorClock: VectorClockState;
}

export class CRDTDocument {
  readonly participants: ORSet<string>;
  readonly stageOutputs: LWWMap<string, string>;
  readonly stageStatuses: LWWMap<string, string>;
  readonly votes: GCounter;
  readonly tags: ORSet<string>;
  readonly metadata: LWWRegister<Record<string, unknown>>;
  readonly vectorClock: VectorClock;

  constructor(
    readonly sessionId: string,
    readonly nodeId: string,
  ) {
    this.participants = new ORSet<string>(nodeId);
    this.stageOutputs = new LWWMap<string, string>(nodeId);
    this.stageStatuses = new LWWMap<string, string>(nodeId);
    this.votes = new GCounter(nodeId);
    this.tags = new ORSet<string>(nodeId);
    this.metadata = new LWWRegister<Record<string, unknown>>(nodeId);
    this.vectorClock = new VectorClock(nodeId);
  }

  /**
   * Merge a remote CRDT document state into this document.
   * All component CRDTs are merged independently; the vector clock
   * is updated to reflect the incoming causal information.
   */
  merge(remote: CRDTDocumentState): void {
    if (remote.sessionId !== this.sessionId) {
      throw new Error(
        `Cannot merge documents for different sessions: ${remote.sessionId} vs ${this.sessionId}`,
      );
    }
    this.participants.merge(remote.participants);
    this.stageOutputs.merge(remote.stageOutputs);
    this.stageStatuses.merge(remote.stageStatuses);
    this.votes.merge(remote.votes);
    this.tags.merge(remote.tags);
    this.metadata.merge(remote.metadata);
    this.vectorClock.merge(remote.vectorClock);
  }

  /** Tick the vector clock after performing a local mutation. */
  tick(): void {
    this.vectorClock.tick();
  }

  /** Serialize the entire document to a transportable JSON state. */
  toState(): CRDTDocumentState {
    return {
      sessionId: this.sessionId,
      nodeId: this.nodeId,
      participants: this.participants.toState(),
      stageOutputs: this.stageOutputs.toState(),
      stageStatuses: this.stageStatuses.toState(),
      votes: this.votes.toState(),
      tags: this.tags.toState(),
      metadata: this.metadata.toState(),
      vectorClock: this.vectorClock.toState(),
    };
  }

  /** Deserialize a document from JSON state. */
  static fromState(state: CRDTDocumentState): CRDTDocument {
    const doc = new CRDTDocument(state.sessionId, state.nodeId);

    // Merge each component — this correctly handles the fromState bootstrapping
    doc.participants.merge(state.participants);
    doc.stageOutputs.merge(state.stageOutputs);
    doc.stageStatuses.merge(state.stageStatuses);
    doc.votes.merge(state.votes);
    doc.tags.merge(state.tags);
    doc.metadata.merge(state.metadata);
    doc.vectorClock.merge(state.vectorClock);

    return doc;
  }

  /** Convenience: get a human-readable snapshot of resolved values. */
  snapshot(): {
    participants: string[];
    stageOutputs: Record<string, string | null>;
    stageStatuses: Record<string, string | null>;
    votes: number;
    tags: string[];
    metadata: Record<string, unknown> | null;
    vectorClock: VectorClockState;
  } {
    return {
      participants: this.participants.value(),
      stageOutputs: this.stageOutputs.value(),
      stageStatuses: this.stageStatuses.value(),
      votes: this.votes.value(),
      tags: this.tags.value(),
      metadata: this.metadata.value(),
      vectorClock: this.vectorClock.toState(),
    };
  }
}
