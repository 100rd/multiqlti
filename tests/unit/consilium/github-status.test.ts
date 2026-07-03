/**
 * github-status.test.ts — LIVE GitHub PR status service (server/services/github-status.ts).
 *
 * Injects a FAKE execFile — no real `gh`, no network. Covers:
 *   - fetchPrStatus maps gh `{state,isDraft}` → OPEN/DRAFT/MERGED/CLOSED;
 *   - graceful degrade to "unknown": unrecognized ref (no gh call), gh throw
 *     (missing/unauth/rate-limit/timeout), non-JSON stdout;
 *   - canonicalPrUrl validates + reconstructs the URL (no free-form/leading-dash
 *     value reaches gh) — and the gh argv uses that canonical URL;
 *   - the TTL cache: a hit inside the window makes ZERO extra gh calls; expiry
 *     refetches (injected clock);
 *   - in-flight de-duplication: concurrent gets for one ref → ONE gh call;
 *   - getMany dedups duplicate refs and bounds work to one call per unique ref;
 *   - size bound: the cache never exceeds maxEntries (oldest evicted).
 */
import { describe, it, expect, vi } from "vitest";
import {
  fetchPrStatus,
  canonicalPrUrl,
  createGithubStatusCache,
  type ExecFileFn,
} from "../../../server/services/github-status.js";

const PR = "https://github.com/acme/widget/pull/42";

/** A fake gh runner returning a fixed `gh pr view --json` payload; counts calls. */
function fakeGh(payload: unknown): { run: ExecFileFn; calls: () => number; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    return { stdout: JSON.stringify(payload), stderr: "" };
  });
  return { run, calls: () => (run as unknown as { mock: { calls: unknown[] } }).mock.calls.length, argv };
}

describe("canonicalPrUrl", () => {
  it("accepts a canonical GitHub PR URL and reconstructs it", () => {
    expect(canonicalPrUrl(PR)).toBe(PR);
    expect(canonicalPrUrl(`${PR}/files`)).toBe(PR); // trailing path stripped
    expect(canonicalPrUrl(`${PR}#discussion`)).toBe(PR);
    expect(canonicalPrUrl(`  ${PR}  `)).toBe(PR); // trimmed
  });

  it("rejects non-PR / non-GitHub / leading-dash refs → null", () => {
    expect(canonicalPrUrl("")).toBeNull();
    expect(canonicalPrUrl("-F/etc/passwd")).toBeNull();
    expect(canonicalPrUrl("https://evil.example.com/acme/widget/pull/1")).toBeNull();
    expect(canonicalPrUrl("https://github.com/acme/widget/issues/1")).toBeNull();
    expect(canonicalPrUrl("https://github.com/acme/widget/pull/notanumber")).toBeNull();
  });
});

describe("fetchPrStatus", () => {
  it("maps OPEN + isDraft:false → OPEN and calls gh with the canonical URL", async () => {
    const gh = fakeGh({ state: "OPEN", isDraft: false });
    expect(await fetchPrStatus(PR, gh.run)).toBe("OPEN");
    expect(gh.argv[0]).toEqual(["pr", "view", PR, "--json", "state,isDraft"]);
  });

  it("maps OPEN + isDraft:true → DRAFT", async () => {
    const gh = fakeGh({ state: "OPEN", isDraft: true });
    expect(await fetchPrStatus(PR, gh.run)).toBe("DRAFT");
  });

  it("maps MERGED → MERGED and CLOSED → CLOSED", async () => {
    expect(await fetchPrStatus(PR, fakeGh({ state: "MERGED", isDraft: false }).run)).toBe("MERGED");
    expect(await fetchPrStatus(PR, fakeGh({ state: "CLOSED", isDraft: false }).run)).toBe("CLOSED");
  });

  it("degrades to unknown for an unrecognized ref WITHOUT calling gh", async () => {
    const gh = fakeGh({ state: "OPEN", isDraft: false });
    expect(await fetchPrStatus("not-a-url", gh.run)).toBe("unknown");
    expect(gh.calls()).toBe(0);
  });

  it("degrades to unknown when gh throws (missing/unauth/rate-limit/timeout)", async () => {
    const run: ExecFileFn = vi.fn(async () => {
      throw new Error("gh: not authenticated / API rate limit exceeded");
    });
    expect(await fetchPrStatus(PR, run)).toBe("unknown");
  });

  it("degrades to unknown on non-JSON stdout or unexpected shape", async () => {
    const bad: ExecFileFn = vi.fn(async () => ({ stdout: "<!DOCTYPE html>", stderr: "" }));
    expect(await fetchPrStatus(PR, bad)).toBe("unknown");
    expect(await fetchPrStatus(PR, fakeGh({ state: "WEIRD" }).run)).toBe("unknown");
  });
});

describe("createGithubStatusCache", () => {
  it("serves a cached hit inside the TTL with ZERO extra gh calls", async () => {
    const gh = fakeGh({ state: "OPEN", isDraft: false });
    let t = 1000;
    const cache = createGithubStatusCache({ ttlMs: 60_000, now: () => t });
    expect(await cache.get(PR, gh.run)).toBe("OPEN");
    t = 30_000; // within TTL
    expect(await cache.get(PR, gh.run)).toBe("OPEN");
    expect(gh.calls()).toBe(1);
  });

  it("refetches after the TTL expires", async () => {
    let payload: { state: string; isDraft: boolean } = { state: "OPEN", isDraft: true };
    let calls = 0;
    const run: ExecFileFn = vi.fn(async () => {
      calls++;
      return { stdout: JSON.stringify(payload), stderr: "" };
    });
    let t = 0;
    const cache = createGithubStatusCache({ ttlMs: 60_000, now: () => t });
    expect(await cache.get(PR, run)).toBe("DRAFT");
    payload = { state: "MERGED", isDraft: false };
    t = 60_001; // past TTL
    expect(await cache.get(PR, run)).toBe("MERGED");
    expect(calls).toBe(2);
  });

  it("de-duplicates concurrent misses for the same ref into ONE gh call", async () => {
    let calls = 0;
    const run: ExecFileFn = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { stdout: JSON.stringify({ state: "OPEN", isDraft: false }), stderr: "" };
    });
    const cache = createGithubStatusCache();
    const [a, b, c] = await Promise.all([
      cache.get(PR, run),
      cache.get(PR, run),
      cache.get(PR, run),
    ]);
    expect([a, b, c]).toEqual(["OPEN", "OPEN", "OPEN"]);
    expect(calls).toBe(1);
  });

  it("getMany dedups duplicate refs → one call per UNIQUE ref", async () => {
    const gh = fakeGh({ state: "OPEN", isDraft: false });
    const cache = createGithubStatusCache();
    const other = "https://github.com/acme/widget/pull/99";
    const map = await cache.getMany([PR, PR, other, PR], gh.run);
    expect(map.get(PR)).toBe("OPEN");
    expect(map.get(other)).toBe("OPEN");
    expect(gh.calls()).toBe(2); // PR + other, not 4
  });

  it("bounds the cache size (oldest evicted past maxEntries)", async () => {
    const gh = fakeGh({ state: "OPEN", isDraft: false });
    const cache = createGithubStatusCache({ maxEntries: 3, ttlMs: 60_000, now: () => 1 });
    for (let n = 0; n < 10; n++) {
      await cache.get(`https://github.com/acme/widget/pull/${n}`, gh.run);
    }
    expect(cache.size()).toBeLessThanOrEqual(3);
  });
});
