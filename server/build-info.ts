import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Build identity, computed ONCE at boot from the git checkout the server runs
 * from. The version number is simply the commit count on HEAD ("count versions
 * by commit"), paired with the short sha for exact provenance.
 *
 * Fail-soft: outside a git checkout (or with git missing) every field is null
 * and callers fall back to the static package version. Never throws, never
 * blocks boot (callers await a cached promise).
 */
export interface BuildInfo {
  /** e.g. "1.0.1234" — 1.0.<commit count on HEAD>. */
  version: string | null;
  /** Short commit sha, e.g. "67d2365b". */
  commit: string | null;
  /** Total commits on HEAD. */
  commitCount: number | null;
}

let cached: Promise<BuildInfo> | null = null;

async function compute(): Promise<BuildInfo> {
  try {
    const [count, sha] = await Promise.all([
      execFileAsync("git", ["rev-list", "--count", "HEAD"], { timeout: 5_000 }),
      execFileAsync("git", ["rev-parse", "--short", "HEAD"], { timeout: 5_000 }),
    ]);
    const commitCount = Number.parseInt(count.stdout.trim(), 10);
    const commit = sha.stdout.trim();
    if (!Number.isFinite(commitCount) || !/^[0-9a-f]{4,40}$/.test(commit)) {
      return { version: null, commit: null, commitCount: null };
    }
    return { version: `1.0.${commitCount}`, commit, commitCount };
  } catch {
    return { version: null, commit: null, commitCount: null };
  }
}

/** Cached-forever build info (the checkout does not change under a running server). */
export function getBuildInfo(): Promise<BuildInfo> {
  cached ??= compute();
  return cached;
}
