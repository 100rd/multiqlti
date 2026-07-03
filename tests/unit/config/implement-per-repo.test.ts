/**
 * implement-per-repo.test.ts — PER-REPO test/lint command overrides.
 *
 * The SDLC `implement` block carries GLOBAL `testCommand`/`lintCommand`/
 * `testRunTimeoutMs`/`coderModel` that today run the SAME command for every repo.
 * `perRepo` adds an OPTIONAL per-repoPath override map; `resolveImplementForRepo`
 * folds a matched override over the global keys. This file pins the pure resolution
 * contract + the additive schema:
 *   1. Schema: `perRepo` defaults to {} (byte-for-byte today), validates fields, and
 *      re-applies the coderModel safe-slug + timeout clamp.
 *   2. selectPerRepoOverride: EXACT match, longest path-boundary prefix, no-match.
 *   3. resolveImplementForRepo: override wins, absent field inherits global, explicit
 *      null overrides, and NO entry ⇒ byte-identical to the global keys.
 */
import { describe, it, expect } from "vitest";
import {
  ConfigSchema,
  resolveImplementForRepo,
  selectPerRepoOverride,
  type AppConfig,
} from "../../../server/config/schema.js";

/** The parsed `implement` block from a (possibly partial) implement config object. */
function implementOf(implement: Record<string, unknown>): AppConfig["pipeline"]["consiliumLoop"]["implement"] {
  const parsed = ConfigSchema.parse({
    pipeline: { consiliumLoop: { implement } },
  });
  return parsed.pipeline.consiliumLoop.implement;
}

describe("schema — implement.perRepo is additive + backward-compatible", () => {
  it("defaults perRepo to {} when absent (byte-for-byte today's config)", () => {
    const impl = implementOf({});
    expect(impl.perRepo).toEqual({});
  });

  it("parses a per-repo entry and keeps the global keys intact", () => {
    const impl = implementOf({
      testCommand: "npm test",
      lintCommand: "npm run lint",
      testRunTimeoutMs: 300000,
      perRepo: {
        "/repos/py": { testCommand: "uv run pytest", coderModel: "sonnet" },
      },
    });
    expect(impl.testCommand).toBe("npm test"); // global untouched
    expect(impl.perRepo["/repos/py"]).toEqual({ testCommand: "uv run pytest", coderModel: "sonnet" });
  });

  it("re-applies the coderModel safe-slug guard to a per-repo entry (rejects flag-like)", () => {
    expect(() =>
      implementOf({ perRepo: { "/repos/x": { coderModel: "--dangerously" } } }),
    ).toThrow();
    // A valid slug passes.
    const impl = implementOf({ perRepo: { "/repos/x": { coderModel: "claude-sonnet" } } });
    expect(impl.perRepo["/repos/x"].coderModel).toBe("claude-sonnet");
  });

  it("re-applies the testRunTimeoutMs clamp to a per-repo entry", () => {
    expect(() => implementOf({ perRepo: { "/repos/x": { testRunTimeoutMs: 5 } } })).toThrow(); // below 10s
    const impl = implementOf({ perRepo: { "/repos/x": { testRunTimeoutMs: 60000 } } });
    expect(impl.perRepo["/repos/x"].testRunTimeoutMs).toBe(60000);
  });

  it("strips unknown fields on a per-repo entry (zod object default)", () => {
    const impl = implementOf({ perRepo: { "/repos/x": { testCommand: "go test ./...", bogus: 1 } } });
    expect(impl.perRepo["/repos/x"]).toEqual({ testCommand: "go test ./..." });
  });
});

describe("selectPerRepoOverride — exact / longest-prefix / no-match", () => {
  const perRepo = {
    "/repos/py": { testCommand: "uv run pytest" },
    "/repos": { testCommand: "make test" },
    "/repos/node/app": { testCommand: "npm test" },
  } as const;

  it("EXACT repoPath match wins", () => {
    expect(selectPerRepoOverride("/repos/py", perRepo)).toEqual({ testCommand: "uv run pytest" });
  });

  it("longest path-boundary PREFIX wins when no exact key", () => {
    // /repos/node/app/pkg is nested under both /repos and /repos/node/app → longest wins.
    expect(selectPerRepoOverride("/repos/node/app/pkg", perRepo)).toEqual({ testCommand: "npm test" });
    // /repos/other is only under /repos.
    expect(selectPerRepoOverride("/repos/other", perRepo)).toEqual({ testCommand: "make test" });
  });

  it("NO match ⇒ undefined (caller falls back to global keys)", () => {
    expect(selectPerRepoOverride("/elsewhere/repo", perRepo)).toBeUndefined();
    expect(selectPerRepoOverride("/repos/py", {})).toBeUndefined();
    expect(selectPerRepoOverride("/repos/py", undefined)).toBeUndefined();
  });

  it("does NOT prefix-match on a non-boundary substring", () => {
    // "/repos-backup" starts with "/repos" textually but is NOT nested under it.
    expect(selectPerRepoOverride("/repos-backup/x", perRepo)).toBeUndefined();
  });

  it("tolerates a trailing slash on the key or the query", () => {
    expect(selectPerRepoOverride("/repos/py/", perRepo)).toEqual({ testCommand: "uv run pytest" });
    expect(selectPerRepoOverride("/repos/py", { "/repos/py/": { testCommand: "x" } })).toEqual({
      testCommand: "x",
    });
  });
});

describe("resolveImplementForRepo — override precedence + backward-compat", () => {
  const globalImpl = implementOf({
    testCommand: "npm test",
    lintCommand: "npm run lint",
    testRunTimeoutMs: 300000,
    coderModel: "claude-sonnet",
    perRepo: {
      "/repos/py": {
        testCommand: "uv run pytest",
        testRunTimeoutMs: 600000,
        coderModel: "opus",
        // lintCommand ABSENT → inherits the global lintCommand.
      },
      "/repos/nolint": { lintCommand: null }, // explicit null overrides → no lint run.
    },
  });

  it("byte-identical to the GLOBAL keys when no per-repo entry matches", () => {
    const eff = resolveImplementForRepo("/repos/unmapped", globalImpl);
    expect(eff).toEqual({
      testCommand: "npm test",
      lintCommand: "npm run lint",
      testRunTimeoutMs: 300000,
      coderModel: "claude-sonnet",
    });
  });

  it("a matched override replaces the field; an ABSENT override field inherits the global", () => {
    const eff = resolveImplementForRepo("/repos/py", globalImpl);
    expect(eff).toEqual({
      testCommand: "uv run pytest", // overridden
      lintCommand: "npm run lint", // inherited (absent in the entry)
      testRunTimeoutMs: 600000, // overridden
      coderModel: "opus", // overridden
    });
  });

  it("an explicit null override wins over a non-null global (no command)", () => {
    const eff = resolveImplementForRepo("/repos/nolint", globalImpl);
    expect(eff.lintCommand).toBeNull(); // null override beats "npm run lint"
    expect(eff.testCommand).toBe("npm test"); // other fields still inherit
  });

  it("with an empty perRepo, resolution equals the raw global keys (contract)", () => {
    const impl = implementOf({ testCommand: "go test ./...", coderModel: "sonnet" });
    const eff = resolveImplementForRepo("/anything", impl);
    expect(eff).toEqual({
      testCommand: "go test ./...",
      lintCommand: null, // global default
      testRunTimeoutMs: 300000, // schema default
      coderModel: "sonnet",
    });
  });
});
