import type { ToolHandler } from "../registry";
import { storage } from "../../storage";

export const memorySearchHandler: ToolHandler = {
  definition: {
    name: "memory_search",
    description: "Search project memories — decisions, patterns, known issues, preferences, and facts stored by previous pipeline runs.",
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
      const memories = await storage.searchMemories(query);

      if (memories.length === 0) {
        return `No memories found matching "${query}".`;
      }

      return memories
        .map((m) => `[${m.type}] ${m.key}: ${m.content} (confidence: ${m.confidence.toFixed(2)})`)
        .join("\n");
    } catch (err) {
      console.warn("[memory-search] Memory search failed:", err);
      return `Memory search unavailable: ${(err as Error).message}`;
    }
  },
};
