/**
 * Unit tests for the external news fetcher (Security H1).
 *
 * The fetcher pulls each curated source via the injected safeFetch seam (which
 * keeps the 5 MiB body cap + SSRF), parses RSS/Atom/HTML with DTD processing and
 * external entities DISABLED, and applies post-parse caps. Covers:
 *   - happy path: RSS + Atom normalization to {title,summary,sourceUri,...},
 *   - XXE / DOCTYPE / <!ENTITY> rejection (hand-rolled parser refuses them),
 *   - billion-laughs / unbounded-node rejection via node caps,
 *   - per-feed item cap + per-field length cap,
 *   - dedup via computeContentHash (same item across feeds collapses),
 *   - atomic per-source skip: an allowlist/SSRF failure on one source does not
 *     abort the others.
 */
import { describe, it, expect } from "vitest";
import {
  parseFeed,
  fetchSources,
  MAX_ITEMS_PER_FEED,
  MAX_TITLE_LEN,
  MAX_SUMMARY_LEN,
  FeedParseError,
  type FetchSourcesDeps,
} from "../../../server/news/news-fetcher";
import { AllowlistError } from "../../../server/knowledge/safe-fetch";

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>AWS What's New</title>
  <item><title>Amazon EKS now supports X</title><description>EKS adds X support.</description><link>https://aws.amazon.com/about-aws/whats-new/2026/06/eks-x/</link><pubDate>Mon, 08 Jun 2026 10:00:00 GMT</pubDate></item>
  <item><title>S3 adds Y</title><description>Details about Y.</description><link>https://aws.amazon.com/about-aws/whats-new/2026/06/s3-y/</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Kubernetes Blog</title>
  <entry><title>Kubernetes 1.33 released</title><summary>New features.</summary><link href="https://kubernetes.io/blog/2026/06/01/k8s-133/"/><updated>2026-06-01T00:00:00Z</updated></entry>
</feed>`;

const XXE = `<?xml version="1.0"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<rss version="2.0"><channel><item><title>&xxe;</title><description>x</description><link>https://aws.amazon.com/x</link></item></channel></rss>`;

const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;">
]>
<rss><channel><item><title>&lol2;</title></item></channel></rss>`;

describe("parseFeed — RSS / Atom normalization", () => {
  it("parses RSS items into normalized records", () => {
    const items = parseFeed(RSS, { sourceName: "AWS", provider: "aws-whatsnew" });
    expect(items.length).toBe(2);
    expect(items[0].title).toBe("Amazon EKS now supports X");
    expect(items[0].summary).toBe("EKS adds X support.");
    expect(items[0].sourceUri).toBe("https://aws.amazon.com/about-aws/whats-new/2026/06/eks-x/");
    expect(items[0].sourceName).toBe("AWS");
    expect(items[0].provider).toBe("aws-whatsnew");
  });

  it("parses Atom entries (summary + link href)", () => {
    const items = parseFeed(ATOM, { sourceName: "K8s", provider: "k8s-blog" });
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("Kubernetes 1.33 released");
    expect(items[0].sourceUri).toBe("https://kubernetes.io/blog/2026/06/01/k8s-133/");
  });
});

describe("parseFeed — XXE / entity hardening (H1)", () => {
  it("rejects a DOCTYPE declaration", () => {
    expect(() => parseFeed(XXE, { sourceName: "AWS", provider: "aws-whatsnew" })).toThrow(FeedParseError);
  });

  it("rejects an <!ENTITY> declaration (billion-laughs vector)", () => {
    expect(() => parseFeed(BILLION_LAUGHS, { sourceName: "x", provider: "aws-whatsnew" })).toThrow(
      FeedParseError,
    );
  });

  it("rejects a SYSTEM/PUBLIC external reference even without a full DOCTYPE", () => {
    const sneaky = `<?xml version="1.0"?><rss><!ENTITY ext SYSTEM "http://evil/"><channel></channel></rss>`;
    expect(() => parseFeed(sneaky, { sourceName: "x", provider: "aws-whatsnew" })).toThrow(FeedParseError);
  });
});

describe("parseFeed — caps (H1 memory bounds)", () => {
  it("caps the number of items per feed", () => {
    const many = Array.from({ length: MAX_ITEMS_PER_FEED + 20 }, (_, i) =>
      `<item><title>t${i}</title><description>d${i}</description><link>https://aws.amazon.com/${i}</link></item>`,
    ).join("");
    const xml = `<?xml version="1.0"?><rss><channel>${many}</channel></rss>`;
    const items = parseFeed(xml, { sourceName: "AWS", provider: "aws-whatsnew" });
    expect(items.length).toBeLessThanOrEqual(MAX_ITEMS_PER_FEED);
  });

  it("truncates over-long titles and summaries", () => {
    const longTitle = "A".repeat(MAX_TITLE_LEN + 500);
    const longSummary = "B".repeat(MAX_SUMMARY_LEN + 500);
    const xml = `<?xml version="1.0"?><rss><channel><item><title>${longTitle}</title><description>${longSummary}</description><link>https://aws.amazon.com/x</link></item></channel></rss>`;
    const items = parseFeed(xml, { sourceName: "AWS", provider: "aws-whatsnew" });
    expect(items[0].title.length).toBeLessThanOrEqual(MAX_TITLE_LEN);
    expect(items[0].summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LEN);
  });

  it("rejects a feed whose raw size blows the node budget", () => {
    const huge = "<item><title>x</title></item>".repeat(200000);
    const xml = `<?xml version="1.0"?><rss><channel>${huge}</channel></rss>`;
    expect(() => parseFeed(xml, { sourceName: "AWS", provider: "aws-whatsnew" })).toThrow(FeedParseError);
  });
});

describe("fetchSources — orchestration over the safeFetch seam", () => {
  function deps(bodyByUrl: Record<string, string>, failUrls: Set<string> = new Set()): FetchSourcesDeps {
    return {
      safeFetch: async (url) => {
        if (failUrls.has(url)) throw new AllowlistError(`blocked: ${url}`);
        const body = bodyByUrl[url];
        if (body === undefined) throw new Error("not found");
        return { status: 200, headers: {}, body, finalUrl: url };
      },
    };
  }

  it("fetches + parses + dedups across configured sources", async () => {
    const sources = [
      { url: "https://aws.amazon.com/feed", sourceName: "AWS", provider: "aws-whatsnew" as const },
      { url: "https://kubernetes.io/feed", sourceName: "K8s", provider: "k8s-blog" as const },
    ];
    const items = await fetchSources(sources, deps({
      "https://aws.amazon.com/feed": RSS,
      "https://kubernetes.io/feed": ATOM,
    }));
    // 2 RSS + 1 Atom = 3 unique
    expect(items.length).toBe(3);
    // every item carries a server-computed content hash
    expect(items.every((i) => /^[0-9a-f]{64}$/.test(i.contentHash))).toBe(true);
  });

  it("dedups identical items appearing in two feeds", async () => {
    const dupRss = `<?xml version="1.0"?><rss><channel><item><title>Same</title><description>Same body</description><link>https://aws.amazon.com/same</link></item></channel></rss>`;
    const sources = [
      { url: "https://aws.amazon.com/a", sourceName: "AWS", provider: "aws-whatsnew" as const },
      { url: "https://aws.amazon.com/b", sourceName: "AWS", provider: "aws-whatsnew" as const },
    ];
    const items = await fetchSources(sources, deps({
      "https://aws.amazon.com/a": dupRss,
      "https://aws.amazon.com/b": dupRss,
    }));
    expect(items.length).toBe(1);
  });

  it("atomically skips a source that fails the allowlist/SSRF gate, keeps the rest", async () => {
    const sources = [
      { url: "https://aws.amazon.com/feed", sourceName: "AWS", provider: "aws-whatsnew" as const },
      { url: "https://evil.example/feed", sourceName: "Evil", provider: "vendor-changelog" as const },
    ];
    const items = await fetchSources(
      sources,
      deps({ "https://aws.amazon.com/feed": RSS }, new Set(["https://evil.example/feed"])),
    );
    // AWS still parsed (2), evil skipped
    expect(items.length).toBe(2);
  });

  it("skips a source whose feed is malformed/hostile without aborting others", async () => {
    const sources = [
      { url: "https://aws.amazon.com/feed", sourceName: "AWS", provider: "aws-whatsnew" as const },
      { url: "https://kubernetes.io/feed", sourceName: "K8s", provider: "k8s-blog" as const },
    ];
    const items = await fetchSources(sources, deps({
      "https://aws.amazon.com/feed": RSS,
      "https://kubernetes.io/feed": XXE,
    }));
    expect(items.length).toBe(2); // only AWS; XXE feed dropped
  });
});
