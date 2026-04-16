import type { ToolHandler } from "../registry";
import { storage } from "../../storage";
import { getFederationManager } from "../../federation/manager-state";
import { MemoryFederationService } from "../../federation/memory-federation";
import type { FederatedMemoryResult } from "../../federation/memory-federation";

/** Timeout for federated search fan-out (ms). */
const FEDERATION_TIMEOUT_MS = 3000;

/**
 * Build a MemoryFederationService on first use and cache it.
 * Returns null when federation is not enabled.
 */
let cachedService: MemoryFederationService | null = null;
function getMemoryFederation(): MemoryFederationService | null {
  if (cachedService) return cachedService;
  const fm = getFederationManager();
  if (!fm || !fm.isEnabled()) return null;
  cachedService = new MemoryFederationService(fm, storage, "local", "local");
  return cachedService;
}

function formatLocalResult(m: { type: string; key: string; content: string; confidence: number }): string {
  return `[${m.type}] ${m.key}: ${m.content} (confidence: ${m.confidence.toFixed(2)})`;
}

function formatFederatedResult(r: FederatedMemoryResult): string {
  const relevance = r.relevance !== undefined ? ` (relevance: ${r.relevance.toFixed(2)})` : "";
  return `[${r.sourceInstanceName}] ${r.content}${relevance}`;
}

export const memorySearchHandler: ToolHandler = {
  definition: {
    name: "memory_search",
    description: "Search project memories — decisions, patterns, known issues, preferences, and facts stored by previous pipeline runs. When federation is enabled, also searches peer instances.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to find relevant memories" },
      },
      required: ["query"],
    },
    source: "builtin",
    tags: ["memory", "search", "context"],
  },
  async execute(args) {
    const query = String(args.query ?? "").trim();
    if (!query) return "Query cannot be empty.";

    try {
      const localMemories = await storage.searchMemories(query);

      const federation = getMemoryFederation();
      if (!federation) {
        if (localMemories.length === 0) {
          return `No memories found matching "${query}".`;
        }
        return localMemories.map(formatLocalResult).join("\n");
      }

      // Build local results for federation merge (only published memories).
      const publishedLocal: FederatedMemoryResult[] = localMemories
        .filter((m) => m.published)
        .map((m) => ({
          id: String(m.id),
          content: m.content,
          tags: (m.tags ?? []) as string[],
          sourceInstance: "local",
          sourceInstanceName: "local",
          relevance: m.confidence,
        }));

      const { results: federatedResults, sources } = await federation.federatedSearch(
        query,
        publishedLocal,
        FEDERATION_TIMEOUT_MS,
      );

      // Combine local (all) + remote (federated) results.
      const localLines = localMemories.map(formatLocalResult);
      const remoteResults = federatedResults.filter((r) => r.sourceInstance !== "local");
      const remoteLines = remoteResults.map(formatFederatedResult);

      if (localLines.length === 0 && remoteLines.length === 0) {
        return `No memories found matching "${query}".`;
      }

      const parts: string[] = [];
      if (localLines.length > 0) {
        parts.push("--- Local ---", ...localLines);
      }
      if (remoteLines.length > 0) {
        parts.push("--- Federated ---", ...remoteLines);
      }

      const sourceInfo = Object.entries(sources)
        .map(([src, count]) => `${src}: ${count}`)
        .join(", ");
      parts.push(`\n(Sources: ${sourceInfo})`);

      return parts.join("\n");
    } catch (err) {
      console.warn("[memory-search] Memory search failed:", err);
      return `Memory search unavailable: ${(err as Error).message}`;
    }
  },
};
