/**
 * spec-autocommit.test.ts — SPEC-3 (spec-as-task.md §4/§5/§7): the auto-commit
 * POLICY that lets a trusted repo skip GATE 1 (the spec PR) and direct-commit a spec
 * as `status: ready`. Covers the pure decision helper `shouldAutoCommitSpec` (the
 * connector seam) and the `specWatch.autoCommit` config surface + validation.
 *
 * The headline invariant is FAIL-CLOSED: the helper returns `true` ONLY for a repo
 * EXPLICITLY on an ENABLED allowlist; every other case falls back to `false` (= open
 * a spec PR, the safe default). It can NEVER widen beyond the configured repos.
 */
import { describe, it, expect } from "vitest";
import { shouldAutoCommitSpec } from "../../../server/services/consilium/spec-parser.js";
import { ConfigSchema } from "../../../server/config/schema.js";

// ─── shouldAutoCommitSpec (the connector seam, pure + fail-closed) ─────────────

describe("shouldAutoCommitSpec — the trusted-flow decision (fail-closed)", () => {
  it("TRUE only for an ENABLED repo that is EXPLICITLY on the allowlist", () => {
    const config = { enabled: true, repos: ["omnius", "multiqlti"] };
    expect(shouldAutoCommitSpec("omnius", config)).toBe(true);
    expect(shouldAutoCommitSpec("multiqlti", config)).toBe(true);
  });

  it("a repo NOT on the allowlist → false (spec PR — the flag never widens)", () => {
    const config = { enabled: true, repos: ["omnius"] };
    expect(shouldAutoCommitSpec("platform-design", config)).toBe(false);
  });

  it("flag OFF (enabled:false) → false even for a listed repo (Gate 1 stands)", () => {
    expect(shouldAutoCommitSpec("omnius", { enabled: false, repos: ["omnius"] })).toBe(false);
  });

  it("flag ABSENT (undefined config) → false (safe default = spec PR)", () => {
    expect(shouldAutoCommitSpec("omnius", undefined)).toBe(false);
  });

  it("enabled but EMPTY allowlist → false (empty ≠ 'all repos' — nothing trusted)", () => {
    expect(shouldAutoCommitSpec("omnius", { enabled: true, repos: [] })).toBe(false);
    // repos omitted entirely is likewise fail-closed.
    expect(shouldAutoCommitSpec("omnius", { enabled: true })).toBe(false);
  });

  it("unknown/empty repo → false (unknown repo ⇒ spec PR)", () => {
    const config = { enabled: true, repos: ["omnius"] };
    expect(shouldAutoCommitSpec(undefined, config)).toBe(false);
    expect(shouldAutoCommitSpec("", config)).toBe(false);
    expect(shouldAutoCommitSpec("   ", config)).toBe(false);
  });

  it("whitespace around repo / allowlist entries is tolerated (trimmed match)", () => {
    expect(shouldAutoCommitSpec("  omnius  ", { enabled: true, repos: [" omnius "] })).toBe(true);
  });

  it("a truthy-but-not-true `enabled` is treated as OFF (strict === true)", () => {
    // Defensive: only a real boolean true opens the gate.
    const cfg = { enabled: 1 as unknown as boolean, repos: ["omnius"] };
    expect(shouldAutoCommitSpec("omnius", cfg)).toBe(false);
  });
});

// ─── config surface + validation (specWatch.autoCommit) ────────────────────────

describe("specWatch.autoCommit — config schema surface + defaults", () => {
  const specWatchOf = (over: Record<string, unknown> = {}) =>
    ConfigSchema.parse({
      pipeline: { consiliumLoop: { specWatch: over } },
    }).pipeline.consiliumLoop.specWatch;

  it("DEFAULT is OFF + empty allowlist (byte-identical inert default)", () => {
    const sw = specWatchOf();
    expect(sw.autoCommit).toEqual({ enabled: false, repos: [] });
  });

  it("an operator can enable + allowlist specific repos", () => {
    const sw = specWatchOf({ autoCommit: { enabled: true, repos: ["omnius"] } });
    expect(sw.autoCommit).toEqual({ enabled: true, repos: ["omnius"] });
  });

  it("the folded config drives the helper end-to-end (only listed repo passes)", () => {
    const sw = specWatchOf({ autoCommit: { enabled: true, repos: ["omnius"] } });
    expect(shouldAutoCommitSpec("omnius", sw.autoCommit)).toBe(true);
    expect(shouldAutoCommitSpec("ghost", sw.autoCommit)).toBe(false);
  });

  it("rejects a malformed autoCommit (non-boolean enabled / non-array repos)", () => {
    expect(() => specWatchOf({ autoCommit: { enabled: "yes" } })).toThrow();
    expect(() => specWatchOf({ autoCommit: { repos: "omnius" } })).toThrow();
  });

  it("GATE 2 is unaffected: autoCommit lives ONLY under specWatch (no code-PR key)", () => {
    // The policy is scoped to the spec-PR gate — it introduces no field that could
    // touch the code-PR merge. Assert the shape is exactly {enabled, repos}.
    const sw = specWatchOf({ autoCommit: { enabled: true, repos: ["omnius"] } });
    expect(Object.keys(sw.autoCommit).sort()).toEqual(["enabled", "repos"]);
  });
});
