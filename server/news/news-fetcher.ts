/**
 * External news fetcher (Security H1).
 *
 * Pulls each curated source via the injected `safeFetch` seam (which keeps the
 * 5 MiB body cap + SSRF defences) and parses RSS/Atom with a HARDENED minimal
 * parser:
 *   - DTD processing + external entities are DISABLED: any DOCTYPE, <!ENTITY>,
 *     or SYSTEM/PUBLIC token is rejected outright (XXE / billion-laughs / SSRF).
 *   - Post-parse caps: max items per feed, max title/summary length, and a raw
 *     node-count budget to bound memory.
 * Each source is fetched + parsed independently — a failure on one source is
 * logged and skipped, never aborting the others. Output items are normalized and
 * deduplicated by the server-computed content hash.
 */
import { computeContentHash, isDuplicate } from "./news-service.js";
import type { SafeFetchResponse } from "../knowledge/safe-fetch.js";
import type { NewsProvider, NewsSource } from "./news-sources.js";

// ─── Caps (H1) ─────────────────────────────────────────────────────────────────

export const MAX_ITEMS_PER_FEED = 40;
export const MAX_TITLE_LEN = 300;
export const MAX_SUMMARY_LEN = 2000;
/** Upper bound on raw feed length to bound parse memory (well under safeFetch's 5 MiB). */
export const MAX_FEED_BYTES = 2 * 1024 * 1024;
/** Upper bound on the number of element-open tokens scanned (anti node-bomb). */
export const MAX_NODES = 50_000;

// ─── Typed error ─────────────────────────────────────────────────────────────

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

// ─── Normalized output ────────────────────────────────────────────────────────

export interface FetchedNewsItem {
  title: string;
  summary: string;
  sourceUri?: string;
  sourceName?: string;
  provider?: NewsProvider;
  publishedAt?: string;
  contentHash: string;
}

export interface ParseContext {
  sourceName: string;
  provider: NewsProvider;
}

// ─── Hardened pre-parse guard (reject DTD / entities) ────────────────────────

const FORBIDDEN_TOKENS = [/<!DOCTYPE/i, /<!ENTITY/i, /\bSYSTEM\b/, /\bPUBLIC\b/];

/** Throw if the raw feed contains any DTD/entity/external-reference token. */
function rejectDtdAndEntities(raw: string): void {
  for (const token of FORBIDDEN_TOKENS) {
    if (token.test(raw)) {
      throw new FeedParseError("feed contains a forbidden DTD/ENTITY/external token");
    }
  }
}

// ─── Minimal tag readers (no DTD, no entity expansion) ───────────────────────

/** Decode ONLY the fixed five XML predefined entities — never custom entities. */
function decodeBasicEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function clean(text: string | undefined, max: number): string {
  if (!text) return "";
  const decoded = decodeBasicEntities(stripCdata(text)).replace(/\s+/g, " ").trim();
  return decoded.length > max ? decoded.slice(0, max) : decoded;
}

/** Extract the inner text of the first <tag>…</tag> inside `block`. */
function firstTag(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : undefined;
}

/** Extract an Atom <link href="…"/> URL, or an RSS <link>…</link>. */
function extractLink(block: string): string | undefined {
  const hrefMatch = block.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (hrefMatch) return hrefMatch[1];
  const textLink = firstTag(block, "link");
  return textLink ? textLink.trim() : undefined;
}

function countNodes(raw: string): number {
  const matches = raw.match(/</g);
  return matches ? matches.length : 0;
}

// ─── Feed parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a feed body into normalized items. Throws FeedParseError on any hostile
 * or oversize input. Handles RSS (<item>) and Atom (<entry>).
 */
export function parseFeed(raw: string, ctx: ParseContext): FetchedNewsItem[] {
  if (raw.length > MAX_FEED_BYTES) {
    throw new FeedParseError(`feed exceeds ${MAX_FEED_BYTES} bytes`);
  }
  rejectDtdAndEntities(raw);
  if (countNodes(raw) > MAX_NODES) {
    throw new FeedParseError(`feed exceeds ${MAX_NODES} node budget`);
  }

  const blocks = extractEntryBlocks(raw);
  const items: FetchedNewsItem[] = [];
  for (const block of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const item = normalizeBlock(block, ctx);
    if (item) items.push(item);
  }
  return items;
}

function extractEntryBlocks(raw: string): string[] {
  const rssItems = raw.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const atomEntries = raw.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  return [...rssItems, ...atomEntries];
}

function normalizeBlock(block: string, ctx: ParseContext): FetchedNewsItem | null {
  const title = clean(firstTag(block, "title"), MAX_TITLE_LEN);
  if (!title) return null;
  const summaryRaw = firstTag(block, "description") ?? firstTag(block, "summary") ?? firstTag(block, "content");
  const summary = clean(summaryRaw, MAX_SUMMARY_LEN);
  const link = extractLink(block);
  const sourceUri = link ? clean(link, 2048) : undefined;
  const publishedRaw = firstTag(block, "pubDate") ?? firstTag(block, "updated") ?? firstTag(block, "published");
  const publishedAt = publishedRaw ? clean(publishedRaw, 64) : undefined;

  return {
    title,
    summary,
    sourceUri,
    sourceName: ctx.sourceName,
    provider: ctx.provider,
    publishedAt,
    contentHash: computeContentHash({ title, summary, sourceUri }),
  };
}

// ─── Orchestration over the safeFetch seam ───────────────────────────────────

export interface FetchSourcesDeps {
  /** SSRF-hardened fetch (the real server/knowledge/safe-fetch.ts `safeFetch`). */
  safeFetch: (url: string) => Promise<SafeFetchResponse>;
  /** Server-side log sink for skipped sources (defaults to console.warn). */
  logError?: (context: string, err: unknown) => void;
}

/**
 * Fetch + parse + dedup across the given sources. Each source is independent:
 * a fetch/allowlist/parse failure on one is logged and skipped. Items are
 * deduplicated by content hash across all sources.
 */
export async function fetchSources(
  sources: readonly NewsSource[],
  deps: FetchSourcesDeps,
): Promise<FetchedNewsItem[]> {
  const log = deps.logError ?? defaultLog;
  const seen = new Set<string>();
  const out: FetchedNewsItem[] = [];

  for (const source of sources) {
    try {
      const res = await deps.safeFetch(source.url);
      const parsed = parseFeed(res.body, { sourceName: source.sourceName, provider: source.provider });
      for (const item of parsed) {
        if (isDuplicate(item.contentHash, seen)) continue;
        seen.add(item.contentHash);
        out.push(item);
      }
    } catch (err) {
      log(`source skipped: ${source.url}`, err);
    }
  }
  return out;
}

function defaultLog(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[news-fetcher] ${context}: ${detail}`);
}
