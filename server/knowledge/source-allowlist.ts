/**
 * Curated source allowlist for the Active Knowledge Base.
 *
 * This is the FIRST line of SSRF defence — a strict host/scheme/path gate on the
 * URL string. It is intentionally NOT sufficient on its own: safe-fetch.ts adds a
 * DNS-resolved-IP gate and connect-pinning to defeat DNS rebinding. Do NOT reuse
 * the string-only guard in maintenance/scout.ts — it is known-weak.
 *
 * Rules enforced here:
 *   - https only
 *   - host must be an exact allowlisted host OR a strict subdomain on a dot boundary
 *   - reject userinfo (`user@host`, `user:pass@host`)
 *   - reject explicit ports
 *   - reject IDN / punycode / any non-ASCII host (homoglyph spoofing)
 *   - case-fold the host before matching
 *   - github.com is path-scoped to the specific repos we trust
 */

/** Hosts allowed by exact match or strict dot-boundary subdomain. */
const ALLOWED_HOSTS: readonly string[] = [
  "terraform-best-practices.com",
  "developer.hashicorp.com",
  "opentofu.org",
] as const;

/**
 * github.com is special: only specific repo path prefixes are trusted.
 * Each entry is matched case-sensitively against the URL pathname prefix.
 */
const GITHUB_HOST = "github.com";
const GITHUB_ALLOWED_PATH_PREFIXES: readonly string[] = [
  "/hashicorp/terraform",
  "/opentofu/opentofu",
] as const;

/** True if `host` equals `allowed` or is a subdomain of it on a dot boundary. */
function matchesHost(host: string, allowed: string): boolean {
  if (host === allowed) return true;
  return host.endsWith("." + allowed);
}

/** Reject any host that is not pure lowercase ASCII letters/digits/hyphen/dot. */
function isPlainAsciiHost(host: string): boolean {
  return /^[a-z0-9.-]+$/.test(host);
}

/** True if the github pathname is under one of the trusted repo prefixes. */
function isAllowedGithubPath(pathname: string): boolean {
  return GITHUB_ALLOWED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

/**
 * Validate a URL string against the curated allowlist.
 * Returns true only for safe, in-scope https URLs.
 */
export function isAllowedSource(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // https only.
  if (parsed.protocol !== "https:") return false;

  // No credentials smuggling.
  if (parsed.username !== "" || parsed.password !== "") return false;

  // No explicit port (forces standard 443).
  if (parsed.port !== "") return false;

  // Case-fold; URL already lowercases the host, but be explicit.
  const host = parsed.hostname.toLowerCase();

  // Reject IDN/punycode/non-ASCII hosts outright (homoglyph spoofing).
  if (host.startsWith("xn--") || host.includes(".xn--")) return false;
  if (!isPlainAsciiHost(host)) return false;

  // github.com: exact host + path-scoped to trusted repos only.
  if (host === GITHUB_HOST) {
    return isAllowedGithubPath(parsed.pathname);
  }

  // Remaining allowlisted hosts (exact or strict subdomain).
  return ALLOWED_HOSTS.some((allowed) => matchesHost(host, allowed));
}
