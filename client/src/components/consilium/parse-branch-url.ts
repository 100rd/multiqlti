/**
 * parse-branch-url.ts — a single pure helper for the "paste a branch URL / custom
 * ref" affordance on the New consilium review dialog (diff/PR review flow).
 *
 * The operator may either pick a branch from the live dropdown OR paste a branch
 * URL (or type a bare ref). This derives the ref the review submits from whatever
 * they pasted:
 *   • GitHub tree URL   — https://github.com/owner/repo/tree/<ref>
 *   • GitLab tree URL   — https://gitlab.com/group/project/-/tree/<ref>
 *   • a bare ref        — main, release/1.2 (passed through unchanged)
 *
 * It is deliberately dependency-free (no React, no DOM) so it is unit-testable in
 * a plain node environment, and it NEVER throws — the value it returns is only
 * ever placed into the JSON review body as `ref` (allowlist-validated server-side),
 * never interpolated into a URL path or shell.
 */

/** The path marker both GitHub (`…/tree/<ref>`) and GitLab (`…/-/tree/<ref>`) share. */
const TREE_MARKER = "/tree/";

/**
 * Derive a git ref from a pasted branch URL, or pass a bare ref through unchanged.
 *
 * Extraction rule: everything after the FIRST `/tree/` is the ref. This covers
 * GitHub (`…/tree/<ref>`) and GitLab (`…/-/tree/<ref>`) alike — the GitLab `-/`
 * stays to the LEFT of the marker, so no provider-specific branching is needed.
 * We then strip a trailing `?query` / `#hash` / slash and URL-decode the result.
 *
 * A ref may legitimately contain slashes (`release/1.2`), so internal slashes are
 * preserved. That makes a subdirectory-browse URL (`…/tree/main/src/app`)
 * genuinely ambiguous with a slash-containing branch — we keep the full remainder
 * rather than guess, matching the documented behaviour.
 *
 * When the input contains no `/tree/`, it is treated as a bare ref and returned
 * trimmed (only a trailing slash is stripped; internal slashes are untouched).
 */
export function parseBranchFromUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const at = trimmed.indexOf(TREE_MARKER);
  if (at === -1) {
    // Not a tree URL → a bare ref. Keep internal slashes; drop a trailing slash.
    return trimmed.replace(/\/+$/, "");
  }

  let ref = trimmed.slice(at + TREE_MARKER.length);
  ref = ref.split(/[?#]/, 1)[0]; // drop any ?query / #hash
  ref = ref.replace(/\/+$/, ""); // drop trailing slash(es)
  try {
    ref = decodeURIComponent(ref); // e.g. an encoded %2F within the ref
  } catch {
    // Malformed percent-encoding — keep the raw ref rather than throw.
  }
  return ref;
}
