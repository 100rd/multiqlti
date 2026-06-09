/**
 * Curated external news sources for the Morning News Board (Security L3).
 *
 * Every source URL MUST pass the EXISTING strict `isAllowedSource` gate
 * (server/knowledge/source-allowlist.ts): https-only, exact host or strict
 * dot-boundary subdomain, no ports/userinfo/punycode. We deliberately reuse that
 * one gate — no parallel weaker check. Hosts were added to ALLOWED_HOSTS there.
 *
 * `provider` is a closed enum used as a stable badge / dedup key namespace; it is
 * NOT user-controlled.
 */
import { isAllowedSource } from "../knowledge/source-allowlist.js";

export const NEWS_PROVIDERS = [
  "aws-whatsnew",
  "k8s-blog",
  "cncf",
  "vendor-changelog",
] as const;
export type NewsProvider = (typeof NEWS_PROVIDERS)[number];

export interface NewsSource {
  url: string;
  sourceName: string;
  provider: NewsProvider;
}

/**
 * The curated feed list. RSS/Atom-first where available (more stable than HTML).
 * Each URL is validated at module load so a typo/regression fails fast.
 */
export const NEWS_SOURCES: readonly NewsSource[] = [
  { url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/", sourceName: "AWS What's New", provider: "aws-whatsnew" },
  { url: "https://kubernetes.io/feed.xml", sourceName: "Kubernetes Blog", provider: "k8s-blog" },
  { url: "https://www.cncf.io/feed/", sourceName: "CNCF Blog", provider: "cncf" },
  { url: "https://developer.hashicorp.com/terraform/changelog", sourceName: "Terraform Changelog", provider: "vendor-changelog" },
] as const;

/**
 * Return only the sources whose URL passes the strict allowlist gate. A source
 * that does not pass is dropped (logged by the caller) — never fetched.
 */
export function allowedNewsSources(sources: readonly NewsSource[] = NEWS_SOURCES): NewsSource[] {
  return sources.filter((s) => isAllowedSource(s.url));
}
