/**
 * RSS/Atom feed fetcher — polls configured library channels and inserts new items.
 *
 * Uses only Node built-ins (fetch + DOMParser-like XML regex parsing) to avoid
 * adding a new dependency. This is intentionally simple; a full XML parser can
 * be swapped in later.
 */

export interface RSSItem {
  title: string;
  link: string;
  description: string;
  author?: string;
  pubDate?: string;
}

/**
 * Fetches and parses an RSS/Atom feed URL. Returns an array of items.
 */
export async function fetchRSSFeed(feedUrl: string): Promise<RSSItem[]> {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "multiqlti-library/1.0" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();
  return parseRSSXml(xml);
}

/**
 * Minimal regex-based RSS/Atom parser.
 * Handles <item> (RSS 2.0) and <entry> (Atom) elements.
 */
function parseRSSXml(xml: string): RSSItem[] {
  const items: RSSItem[] = [];

  // RSS 2.0 — <item>...</item>
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const block of rssItems) {
    items.push({
      title: extractTag(block, "title"),
      link: extractTag(block, "link"),
      description: stripHtml(extractTag(block, "description")),
      author: extractTag(block, "dc:creator") || extractTag(block, "author") || undefined,
      pubDate: extractTag(block, "pubDate") || undefined,
    });
  }

  // Atom — <entry>...</entry>
  if (items.length === 0) {
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
    for (const block of entries) {
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      items.push({
        title: extractTag(block, "title"),
        link: linkMatch?.[1] ?? "",
        description: stripHtml(extractTag(block, "summary") || extractTag(block, "content")),
        author: extractTag(block, "name") || undefined,
        pubDate: extractTag(block, "published") || extractTag(block, "updated") || undefined,
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(re);
  return match ? match[1].trim() : "";
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}
