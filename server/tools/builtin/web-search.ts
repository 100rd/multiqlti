import type { ToolHandler } from "../registry";
import { configLoader } from "../../config/loader";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results: TavilyResult[];
}

interface DdgResult {
  FirstURL?: string;
  Text?: string;
}

interface DdgResponse {
  RelatedTopics?: DdgResult[];
  Abstract?: string;
  AbstractURL?: string;
  AbstractText?: string;
}

async function searchWithTavily(query: string, limit: number): Promise<string> {
  const apiKey = configLoader.get().providers.tavily?.apiKey;
  if (!apiKey) throw new Error("No Tavily API key");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as TavilyResponse;
  const results = data.results ?? [];

  if (results.length === 0) return "No results found.";

  return results
    .slice(0, limit)
    .map((r) => `## [${r.title}](${r.url})\n${r.content}`)
    .join("\n\n");
}

async function searchWithDuckDuckGo(query: string, limit: number): Promise<string> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`DuckDuckGo API error ${res.status}`);

  const data = (await res.json()) as DdgResponse;
  const lines: string[] = [];

  if (data.AbstractText && data.AbstractURL) {
    lines.push(`## [Abstract](${data.AbstractURL})\n${data.AbstractText}`);
  }

  const topics = (data.RelatedTopics ?? []).filter((t) => t.FirstURL && t.Text);
  for (const topic of topics.slice(0, limit - (lines.length > 0 ? 1 : 0))) {
    lines.push(`## [${topic.Text ?? ""}](${topic.FirstURL ?? ""})\n${topic.Text ?? ""}`);
  }

  if (lines.length === 0) return "No results found via DuckDuckGo.";
  return lines.join("\n\n");
}

export const webSearchHandler: ToolHandler = {
  definition: {
    name: "web_search",
    description: "Search the internet for current information. Returns top results as formatted text.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Maximum number of results (default 5)", default: 5 },
      },
      required: ["query"],
    },
    source: "builtin",
    tags: ["search", "internet"],
  },
  async execute(args) {
    const query = String(args.query ?? "");
    const limit = Math.min(Number(args.limit ?? 5), 10);

    if (!query.trim()) return "Query cannot be empty.";

    try {
      return await searchWithTavily(query, limit);
    } catch (tavilyErr) {
      console.warn(`[web-search] Tavily failed (${(tavilyErr as Error).message}), falling back to DuckDuckGo`);
      try {
        return await searchWithDuckDuckGo(query, limit);
      } catch (ddgErr) {
        return `Search failed. Tavily: ${(tavilyErr as Error).message}. DuckDuckGo: ${(ddgErr as Error).message}`;
      }
    }
  },
};
