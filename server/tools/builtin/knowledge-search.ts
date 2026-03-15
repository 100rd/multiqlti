import type { ToolHandler } from "../registry";
import { storage } from "../../storage";

export const knowledgeSearchHandler: ToolHandler = {
  definition: {
    name: "knowledge_search",
    description: "Search through previous pipeline runs and LLM responses stored in the system. Useful for finding prior analysis, past decisions, or previous outputs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to find relevant past responses" },
        limit: { type: "number", description: "Maximum number of results (default 5)", default: 5 },
      },
      required: ["query"],
    },
    source: "builtin",
    tags: ["knowledge", "search", "history"],
  },
  async execute(args) {
    const query = String(args.query ?? "").trim();
    const limit = Math.min(Number(args.limit ?? 5), 20);

    if (!query) return "Query cannot be empty.";

    try {
      // Try storage LLM requests search via ILIKE on response_content
      const { rows } = await storage.getLlmRequests({
        limit,
        page: 1,
      });

      if (!rows || rows.length === 0) {
        return "No previous pipeline responses found in knowledge base.";
      }

      const lower = query.toLowerCase();
      const matching = rows.filter((r) =>
        r.responseContent?.toLowerCase().includes(lower) ||
        r.systemPrompt?.toLowerCase().includes(lower),
      ).slice(0, limit);

      if (matching.length === 0) {
        return `No results found matching "${query}" in knowledge base.`;
      }

      return matching
        .map((r, i) => {
          const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "unknown date";
          const preview = (r.responseContent ?? "").slice(0, 500);
          return `### Result ${i + 1} (${r.modelSlug}, ${date})\n${preview}${preview.length >= 500 ? "..." : ""}`;
        })
        .join("\n\n");
    } catch (err) {
      // Fallback when PG not available
      console.warn("[knowledge-search] Storage search failed:", err);
      return `Knowledge base search unavailable: ${(err as Error).message}`;
    }
  },
};
