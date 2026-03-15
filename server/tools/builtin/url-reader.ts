import type { ToolHandler } from "../registry";

export const urlReaderHandler: ToolHandler = {
  definition: {
    name: "url_reader",
    description: "Read and extract content from a web page URL. Returns clean markdown.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to read" },
      },
      required: ["url"],
    },
    source: "builtin",
    tags: ["web", "content"],
  },
  async execute(args) {
    const url = String(args.url ?? "").trim();
    if (!url) return "URL cannot be empty.";

    // Basic URL validation — must start with http/https
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return "Invalid URL: must start with http:// or https://";
    }

    const readerUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(readerUrl, {
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      return `Failed to read URL (HTTP ${res.status}). The page may not be accessible.`;
    }

    const text = await res.text();
    // Limit output to ~8000 chars to keep prompt size reasonable
    if (text.length > 8000) {
      return text.slice(0, 8000) + "\n\n[Content truncated at 8000 characters]";
    }
    return text || "Page returned no content.";
  },
};
