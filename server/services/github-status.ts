/**
 * github-status.ts — LIVE GitHub PR status for the PR REVIEW QUEUE.
 *
 * The queue's `prRef` is written by `pr-wrapper.ts` (a real GitHub Draft-PR URL).
 * That module already establishes the ONE GitHub auth path in this server: the
 * local `gh` CLI, run under a SANITIZED env that keeps only the intended token var
 * (`GH_TOKEN`/`GITHUB_TOKEN`) and strips every inherited `GH_*` so a poisoned
 * ambient env cannot redirect `gh` to an attacker host and exfiltrate the token
 * (pr-wrapper H-7b). This service reuses that exact discipline to READ a PR's state.
 *
 * Contract (never-throw, fail-open):
 *   - `fetchPrStatus(prRef)` maps `gh pr view <url> --json state,isDraft` to a
 *     {@link GithubPrStatus}. A ref that is not a recognizable GitHub PR URL, a
 *     missing/unauthenticated `gh`, a timeout, a rate-limit, or a parse error ALL
 *     degrade to `"unknown"`. It NEVER throws and NEVER blocks indefinitely.
 *   - A short-TTL cache (default 60s) with in-flight de-duplication bounds GitHub
 *     traffic: repeated polls and duplicate refs within a request collapse to ONE
 *     `gh` call per ref per TTL window (defends N+1 + rate limits). The cache is
 *     size-bounded (LRU-ish eviction of the oldest inserted entry) so it cannot grow
 *     unbounded from many distinct refs.
 *   - `getMany` fetches a set of refs with BOUNDED concurrency.
 *
 * SECURITY:
 *   - No server-side GitHub auth is REQUIRED: without a token `gh` fails and we
 *     return `"unknown"`. Live status simply needs `GH_TOKEN`/`GITHUB_TOKEN` (or a
 *     `gh auth login` identity) present for the server process.
 *   - The token is NEVER read, logged, or returned here — only handed to `gh` via
 *     the sanitized env. Error strings are path-scrubbed before they surface.
 *   - `prRef` is validated to the canonical `https://github.com/<o>/<r>/pull/<n>`
 *     shape and RECONSTRUCTED from its captures before reaching `gh` — nothing
 *     free-form (and nothing leading-dash) can be interpreted as a flag.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { GithubPrStatus } from "@shared/pr-queue";

/** Minimal `gh`-runner surface (unit tests inject a fake — no real `gh`/network). */
export type ExecFileFn = (
  file: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync: ExecFileFn = promisify(execFile);

/** Canonical GitHub PR URL. Captures owner, repo, number; ignores any trailing bits. */
const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([0-9]+)(?:[/#?].*)?$/;

/** The single token var this server intends to expose to `gh` (parity w/ pr-wrapper). */
const KEEP_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/** Per-`gh`-call wall-clock budget — the route must never hang on a slow GitHub. */
const GH_TIMEOUT_MS = 15_000;

/**
 * Sanitized env (pr-wrapper H-7b parity): drop every inherited `GH_*`, then re-add
 * only the intended token var(s). A poisoned ambient env can no longer redirect `gh`
 * to an attacker host and leak the token.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GH_")) continue;
    env[k] = v;
  }
  for (const tokenVar of KEEP_TOKEN_VARS) {
    if (process.env[tokenVar]) env[tokenVar] = process.env[tokenVar];
  }
  return env;
}

/** Reconstruct the canonical PR URL from a validated ref, or `null` if unrecognized. */
export function canonicalPrUrl(prRef: string): string | null {
  const m = PR_URL_RE.exec(prRef.trim());
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
}

/** Map `gh`'s `{ state, isDraft }` to our status; anything unexpected → `"unknown"`. */
function mapGhView(raw: unknown): GithubPrStatus {
  if (!raw || typeof raw !== "object") return "unknown";
  const { state, isDraft } = raw as { state?: unknown; isDraft?: unknown };
  const s = typeof state === "string" ? state.toUpperCase() : "";
  if (s === "MERGED") return "MERGED";
  if (s === "CLOSED") return "CLOSED";
  if (s === "OPEN") return isDraft === true ? "DRAFT" : "OPEN";
  return "unknown";
}

/**
 * Fetch LIVE status for one `prRef` (uncached). Never throws; every failure path
 * (unrecognized ref, `gh` missing/unauth/timeout/rate-limit, bad JSON) → `"unknown"`.
 */
export async function fetchPrStatus(
  prRef: string,
  run: ExecFileFn = execFileAsync,
): Promise<GithubPrStatus> {
  const url = canonicalPrUrl(prRef);
  if (!url) return "unknown"; // not a GitHub PR URL — nothing to reconcile.
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "view", url, "--json", "state,isDraft"],
      { timeout: GH_TIMEOUT_MS, env: sanitizedEnv() },
    );
    return mapGhView(JSON.parse(stdout || "null"));
  } catch {
    // gh absent / unauthenticated / rate-limited / timed out / non-JSON → fail open.
    return "unknown";
  }
}

// ─── TTL + in-flight-dedup + bounded cache ───────────────────────────────────────

interface CacheEntry {
  status: GithubPrStatus;
  expiresAt: number;
}

export interface GithubStatusCache {
  /** Cached live status for one ref (fetch on miss/expiry; dedup concurrent misses). */
  get(prRef: string, run?: ExecFileFn): Promise<GithubPrStatus>;
  /** Cached live status for many refs with bounded concurrency; unique refs only. */
  getMany(prRefs: string[], run?: ExecFileFn): Promise<Map<string, GithubPrStatus>>;
  clear(): void;
  size(): number;
}

export interface GithubStatusCacheOptions {
  /** Freshness window per ref. Default 60s — short enough to catch a merge quickly. */
  ttlMs?: number;
  /** Hard cap on resolved entries; oldest-inserted evicted past it. Default 1000. */
  maxEntries?: number;
  /** Max concurrent `gh` calls in `getMany`. Default 6 — bounds the burst. */
  concurrency?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
}

/**
 * Build an isolated status cache. The route uses the module singleton
 * {@link githubStatusCache}; tests construct their own instance so state never
 * leaks between cases.
 */
export function createGithubStatusCache(
  opts: GithubStatusCacheOptions = {},
): GithubStatusCache {
  const ttlMs = opts.ttlMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 1000;
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const now = opts.now ?? Date.now;

  const entries = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<GithubPrStatus>>();

  /** Evict expired first, then oldest-inserted, until under the size cap. */
  function evictIfNeeded(): void {
    if (entries.size <= maxEntries) return;
    const t = now();
    for (const [k, e] of entries) {
      if (e.expiresAt <= t) entries.delete(k);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  async function get(prRef: string, run?: ExecFileFn): Promise<GithubPrStatus> {
    const t = now();
    const hit = entries.get(prRef);
    if (hit && hit.expiresAt > t) return hit.status;

    // Collapse a concurrent stampede for the same ref into a single `gh` call.
    const existing = inflight.get(prRef);
    if (existing) return existing;

    const p = fetchPrStatus(prRef, run)
      .then((status) => {
        entries.set(prRef, { status, expiresAt: now() + ttlMs });
        evictIfNeeded();
        return status;
      })
      .finally(() => {
        inflight.delete(prRef);
      });
    inflight.set(prRef, p);
    return p;
  }

  async function getMany(
    prRefs: string[],
    run?: ExecFileFn,
  ): Promise<Map<string, GithubPrStatus>> {
    const unique = [...new Set(prRefs)];
    const out = new Map<string, GithubPrStatus>();
    let i = 0;
    async function worker(): Promise<void> {
      while (i < unique.length) {
        const ref = unique[i++];
        out.set(ref, await get(ref, run));
      }
    }
    const workers = Array.from(
      { length: Math.min(concurrency, unique.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return out;
  }

  return {
    get,
    getMany,
    clear: () => {
      entries.clear();
      inflight.clear();
    },
    size: () => entries.size,
  };
}

/** Process-wide singleton the route uses (60s TTL, bounded). */
export const githubStatusCache = createGithubStatusCache();
