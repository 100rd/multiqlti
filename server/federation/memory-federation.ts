import crypto from "crypto";
import type { FederationManager } from "./index.js";
import type { FederationMessage, PeerInfo } from "./types.js";
import type { IStorage } from "../storage.js";
import type { MemoryScope } from "@shared/types";

/**
 * A single memory record enriched with its source instance metadata.
 * Returned from federated searches so callers can attribute results.
 */
export interface FederatedMemoryResult {
  id: string;
  content: string;
  tags: string[];
  sourceInstance: string;
  sourceInstanceName: string;
  relevance?: number;
}

interface PendingQuery {
  resolve: (value: { results: FederatedMemoryResult[]; sources: Record<string, number> }) => void;
  results: FederatedMemoryResult[];
  sources: Record<string, number>;
  timeout: ReturnType<typeof setTimeout>;
  expected: number;
  received: number;
}

/**
 * Federated memory search — fan-out queries across all connected peers,
 * merge results with a configurable timeout, and return attribution metadata.
 *
 * Message types handled:
 *   memory:query    — incoming search request from a peer
 *   memory:response — search results returned by a peer
 */
export class MemoryFederationService {
  private pendingQueries = new Map<string, PendingQuery>();

  constructor(
    private readonly federation: FederationManager,
    private readonly storage: IStorage,
    private readonly instanceId: string,
    private readonly instanceName: string,
  ) {
    this.federation.on("memory:query", this.handleQuery.bind(this));
    this.federation.on("memory:response", this.handleResponse.bind(this));
  }

  /**
   * Fan-out a search query to every connected peer and merge the responses
   * with local results.  Remote peers that fail to respond within
   * `timeoutMs` are silently ignored.
   */
  async federatedSearch(
    query: string,
    localResults: FederatedMemoryResult[],
    timeoutMs = 3000,
  ): Promise<{ results: FederatedMemoryResult[]; sources: Record<string, number> }> {
    const peers = this.federation.getPeers();

    // No peers — short-circuit with local-only results.
    if (peers.length === 0) {
      return { results: localResults, sources: { local: localResults.length } };
    }

    const correlationId = crypto.randomUUID();

    return new Promise((resolve) => {
      const sources: Record<string, number> = { local: localResults.length };
      const allResults = [...localResults];

      const timer = setTimeout(() => {
        this.pendingQueries.delete(correlationId);
        resolve({ results: allResults, sources });
      }, timeoutMs);

      this.pendingQueries.set(correlationId, {
        resolve,
        results: allResults,
        sources,
        timeout: timer,
        expected: peers.length,
        received: 0,
      });

      // Broadcast search to all connected peers.
      this.federation.send("memory:query", {
        query,
        correlationId,
        sourceInstance: this.instanceId,
        sourceInstanceName: this.instanceName,
      });
    });
  }

  // ── Incoming message handlers ──────────────────────────────────────────────

  /**
   * Handle an incoming memory:query from a peer.
   * Searches local storage for published (global-scope) memories and returns
   * matching results via a memory:response message.
   */
  private async handleQuery(msg: FederationMessage, _peer: PeerInfo): Promise<void> {
    const { query, correlationId, sourceInstance } = msg.payload as {
      query: string;
      correlationId: string;
      sourceInstance: string;
    };

    try {
      // Only share published global-scope memories with peers.
      const localMatches = await this.storage.searchMemories(query, "global" as MemoryScope);
      const publishedMatches = localMatches.filter((m) => m.published);
      const results: FederatedMemoryResult[] = publishedMatches.map((m) => ({
        id: String(m.id),
        content: m.content,
        tags: (m.tags ?? []) as string[],
        sourceInstance: this.instanceId,
        sourceInstanceName: this.instanceName,
        relevance: m.confidence ?? undefined,
      }));

      this.federation.send(
        "memory:response",
        { correlationId, results, sourceInstance: this.instanceId },
        sourceInstance, // directed reply
      );
    } catch {
      // If local search fails, respond with empty results so the caller
      // does not hang waiting for us.
      this.federation.send(
        "memory:response",
        { correlationId, results: [], sourceInstance: this.instanceId },
        sourceInstance,
      );
    }
  }

  /**
   * Handle a memory:response from a peer, accumulating results into the
   * pending query.  When all expected responses arrive, resolve the promise
   * early (before the timeout fires).
   */
  private handleResponse(msg: FederationMessage, _peer: PeerInfo): void {
    const { correlationId, results, sourceInstance } = msg.payload as {
      correlationId: string;
      results: FederatedMemoryResult[];
      sourceInstance: string;
    };

    const pending = this.pendingQueries.get(correlationId);
    if (!pending) return;

    pending.results.push(...results);
    pending.sources[sourceInstance] = results.length;
    pending.received++;

    if (pending.received >= pending.expected) {
      clearTimeout(pending.timeout);
      this.pendingQueries.delete(correlationId);
      pending.resolve({ results: pending.results, sources: pending.sources });
    }
  }
}
