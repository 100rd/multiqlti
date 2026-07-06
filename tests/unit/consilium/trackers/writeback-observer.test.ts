/**
 * writeback-observer.test.ts — TRACK-2: the read-only loop-state observer that
 * writes the lifecycle back to the origin issue. FAKE `gh` (by argv) + a FAKE
 * loop-state source (injected getLoops). Covers:
 *   - launched -> PR-open -> converged posts EXACTLY ONE comment per phase, and is
 *     idempotent on re-poll (the on-issue markers dedup — restart-safe);
 *   - a failed loop posts the #486 status-explanation once;
 *   - verdictComments OFF => no per-verdict noise; ON => one verdict/round;
 *   - a NON-tracker loop (no spec.source) => never commented on;
 *   - a gh outage (unreadable issue) => skipped, never crashes;
 *   - a CLOSED issue is left alone (no comment) by default;
 *   - a loop in another repo is not cross-attributed.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { TrackerWritebackObserver } from "../../../../server/services/consilium/trackers/writeback-observer.js";
import type { TrackerWritebackObserverDeps } from "../../../../server/services/consilium/trackers/writeback-observer.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow, ConsiliumLoopRow } from "@shared/schema";
import type { AppConfig } from "../../../../server/config/schema.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A fake `gh` that serves `issue view --json state,comments` and records writes. */
function fakeGh(opts: {
  state?: string;
  comments?: string[];
  unreadable?: boolean; // issue view returns non-JSON => runGhJson degrades to null
  throwOnComment?: boolean;
}): { run: ExecFileFn; argv: string[][]; commentBodies: () => string[] } {
  const argv: string[][] = [];
  // Mutable comment ledger so a second pass "sees" what the first posted.
  const ledger: string[] = [...(opts.comments ?? [])];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      if (opts.unreadable) return { stdout: "not json", stderr: "" };
      return {
        stdout: JSON.stringify({
          state: opts.state ?? "OPEN",
          comments: ledger.map((b) => ({ body: b })),
        }),
        stderr: "",
      };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      if (opts.throwOnComment) throw Object.assign(new Error("boom"), { stderr: "rate limited" });
      // The body arrives via --body-file; for the ledger we record the marker-carrying
      // body by reading the flag's file is overkill — instead the observer's callers
      // append here through the comment recorder below. We approximate by storing a
      // placeholder; specific marker assertions use argv + a body capture (see below).
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "issue" && args[1] === "reopen") {
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, argv, commentBodies: () => ledger };
}

const commentCalls = (argv: string[][]) =>
  argv.filter((a) => a[0] === "issue" && a[1] === "comment").length;
const reopenCalls = (argv: string[][]) =>
  argv.filter((a) => a[0] === "issue" && a[1] === "reopen").length;

/** A minimally-shaped consilium loop row for the observer (only fields it reads). */
function makeLoop(p: Partial<ConsiliumLoopRow> & { id: string }): ConsiliumLoopRow {
  const base = {
    id: p.id,
    projectId: "proj-1",
    groupId: "grp-1",
    state: "developing",
    round: 1,
    maxRounds: 6,
    repoPath: "/repo",
    lastReviewedCommit: null,
    reviewRef: null,
    reviewMode: null,
    engineerInstruction: null,
    appliedSkills: null,
    triggerProvenance: {
      triggerId: "spec-watch-1",
      triggerType: "file_change",
      eventDigest: "abc123",
      firedAt: "2026-07-01T00:00:00.000Z",
      spec: {
        specPath: "/repo/docs/specs/gh-issue-7.md",
        status: "ready",
        source: { kind: "github", ref: "7", url: "https://github.com/acme/widget/issues/7" },
      },
    },
    archetype: null,
    archetypeSource: null,
    archetypeRationale: null,
    archetypeParams: null,
    archetypeDecidedAt: null,
    currentIterationNumber: null,
    reviewRedrive: null,
    devGroupId: null,
    prRef: null,
    headCommitAtReview: null,
    openP0: null,
    error: null,
    createdBy: "user-1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date(), // recent so it's within the observe window
    completedAt: null,
  };
  return { ...base, ...p } as ConsiliumLoopRow;
}

function makeTrigger(config: Record<string, unknown>): TriggerRow {
  return {
    id: "trig-1",
    projectId: "proj-1",
    type: "tracker_event",
    config,
    enabled: true,
  } as unknown as TriggerRow;
}

/** AppConfig stub with the tracker + writeback switches on (master switch on). */
function cfg(overrides?: {
  master?: boolean;
  tracker?: boolean;
  writeback?: boolean;
  pollIntervalSec?: number;
}): AppConfig {
  return {
    features: {
      triggers: {
        enabled: overrides?.master ?? true,
        tracker: {
          enabled: overrides?.tracker ?? true,
          pollIntervalSec: overrides?.pollIntervalSec ?? 300,
          writeback: { enabled: overrides?.writeback ?? true },
        },
      },
    },
  } as unknown as AppConfig;
}

function makeObserver(
  loops: ConsiliumLoopRow[],
  run: ExecFileFn,
  triggerConfig: Record<string, unknown>,
  config = cfg(),
): TrackerWritebackObserver {
  const deps: TrackerWritebackObserverDeps = {
    getEnabledTriggersByType: async () => [makeTrigger(triggerConfig)],
    runInProject: async (_id, fn) => fn(),
    getLoops: async () => loops,
    config: () => config,
    runGh: run,
    log: () => {},
    now: () => Date.now(),
  };
  return new TrackerWritebackObserver(deps);
}

const TRACKER_CONFIG = { tracker: "github", repo: "acme/widget", targetRepoPath: "/repo" };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TrackerWritebackObserver — lifecycle", () => {
  it("posts exactly one START comment for an in-flight loop and is idempotent on re-poll", async () => {
    // Re-implement the gh with a REAL ledger that captures posted marker bodies so a
    // second pass sees them (marker dedup across restarts is the on-issue ledger).
    const ledger: string[] = [];
    const argv: string[][] = [];
    let pendingBody: string | null = null;
    const run: ExecFileFn = vi.fn(async (_f, args: string[]) => {
      argv.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({ state: "OPEN", comments: ledger.map((b) => ({ body: b })) }),
          stderr: "",
        };
      }
      if (args[0] === "issue" && args[1] === "comment") {
        // Capture the --body-file content by reading the temp file the poster wrote.
        const idx = args.indexOf("--body-file");
        if (idx >= 0) {
          pendingBody = readFileSync(args[idx + 1], "utf8");
          ledger.push(pendingBody);
        }
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const loop = makeLoop({ id: "loop-A", state: "developing" });
    const obs = makeObserver([loop], run, TRACKER_CONFIG);

    await obs.observeAll();
    expect(commentCalls(argv)).toBe(1);
    expect(ledger[0]).toContain("factory:track2:start:loop-A");
    expect(ledger[0]).toContain("work starting");

    // Re-poll (simulate a restart — no in-memory state; only the on-issue ledger).
    const before = commentCalls(argv);
    await obs.observeAll();
    expect(commentCalls(argv)).toBe(before); // no second START — marker dedup.
  });

  it("launched -> PR-open -> converged posts one comment per phase", async () => {
    const ledger: string[] = [];
    const argv: string[][] = [];
    const run: ExecFileFn = vi.fn(async (_f, args: string[]) => {
      argv.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({ state: "OPEN", comments: ledger.map((b) => ({ body: b })) }),
          stderr: "",
        };
      }
      if (args[0] === "issue" && args[1] === "comment") {
        const idx = args.indexOf("--body-file");
        ledger.push(readFileSync(args[idx + 1], "utf8"));
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    // The observer re-reads getLoops each pass; mutate the loop between passes.
    const loop = makeLoop({ id: "loop-B", state: "developing" });
    const deps: TrackerWritebackObserverDeps = {
      getEnabledTriggersByType: async () => [makeTrigger(TRACKER_CONFIG)],
      runInProject: async (_id, fn) => fn(),
      getLoops: async () => [loop],
      config: () => cfg(),
      runGh: run,
      log: () => {},
    };
    const obs = new TrackerWritebackObserver(deps);

    await obs.observeAll(); // START
    loop.state = "awaiting_merge";
    loop.prRef = "https://github.com/acme/widget/pull/9";
    await obs.observeAll(); // PR opened
    loop.state = "converged";
    loop.openP0 = 0;
    await obs.observeAll(); // TERMINAL (converged)

    const bodies = ledger.join("\n---\n");
    expect(bodies).toContain("factory:track2:start:loop-B");
    expect(bodies).toContain("factory:track2:pr:loop-B");
    expect(bodies).toContain("factory:track2:terminal:loop-B");
    expect(bodies).toContain("pull/9");
    // Converged uses the #486 explanation title.
    expect(bodies).toContain("Converged");
    // Exactly 3 phase comments (start, pr, terminal) — no dupes.
    expect(ledger.filter((b) => b.includes("factory:track2:")).length).toBe(3);
  });

  it("a failed loop posts the #486 status-explanation once", async () => {
    const ledger: string[] = [];
    const argv: string[][] = [];
    const run: ExecFileFn = vi.fn(async (_f, args: string[]) => {
      argv.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return {
          stdout: JSON.stringify({ state: "OPEN", comments: ledger.map((b) => ({ body: b })) }),
          stderr: "",
        };
      }
      if (args[0] === "issue" && args[1] === "comment") {
        const idx = args.indexOf("--body-file");
        ledger.push(readFileSync(args[idx + 1], "utf8"));
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const loop = makeLoop({ id: "loop-F", state: "failed", error: "round 2 failed: gateway timeout" });
    const obs = makeObserver([loop], run, TRACKER_CONFIG);

    await obs.observeAll();
    const terminal = ledger.filter((b) => b.includes("factory:track2:terminal:loop-F"));
    expect(terminal.length).toBe(1);
    expect(terminal[0]).toContain("Failed");
    expect(terminal[0]).toContain("gateway timeout"); // the loop's own error as the explanation
    // No START on an already-terminal loop (in-flight rows are skipped).
    expect(ledger.some((b) => b.includes("factory:track2:start:loop-F"))).toBe(false);

    await obs.observeAll(); // idempotent
    expect(ledger.filter((b) => b.includes("factory:track2:terminal:loop-F")).length).toBe(1);
  });

  it("verdictComments OFF => no per-verdict comment; ON => one verdict for the round", async () => {
    const mk = (verdict: boolean) => {
      const ledger: string[] = [];
      const argv: string[][] = [];
      const run: ExecFileFn = vi.fn(async (_f, args: string[]) => {
        argv.push(args);
        if (args[0] === "issue" && args[1] === "view") {
          return {
            stdout: JSON.stringify({ state: "OPEN", comments: ledger.map((b) => ({ body: b })) }),
            stderr: "",
          };
        }
        if (args[0] === "issue" && args[1] === "comment") {
          const idx = args.indexOf("--body-file");
          ledger.push(readFileSync(args[idx + 1], "utf8"));
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      const loop = makeLoop({ id: "loop-V", state: "developing", round: 2, openP0: 3 });
      const obs = makeObserver([loop], run, { ...TRACKER_CONFIG, writeback: { verdictComments: verdict } });
      return { obs, ledger };
    };

    const off = mk(false);
    await off.obs.observeAll();
    expect(off.ledger.some((b) => b.includes("factory:track2:verdict:"))).toBe(false);

    const on = mk(true);
    await on.obs.observeAll();
    const verdicts = on.ledger.filter((b) => b.includes("factory:track2:verdict:loop-V:2"));
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]).toContain("3 P0");
  });

  it("a NON-tracker loop (no spec.source) is never commented on", async () => {
    const { run, argv } = fakeGh({ state: "OPEN" });
    const loop = makeLoop({ id: "loop-N" });
    // Strip the spec provenance -> a human/API/file_change loop.
    loop.triggerProvenance = {
      triggerId: "t", triggerType: "file_change", eventDigest: "d", firedAt: "2026-07-01T00:00:00Z",
    } as ConsiliumLoopRow["triggerProvenance"];
    const obs = makeObserver([loop], run, TRACKER_CONFIG);
    await obs.observeAll();
    expect(argv.length).toBe(0); // not even a read.
  });

  it("a loop in a DIFFERENT repo is not cross-attributed", async () => {
    const { run, argv } = fakeGh({ state: "OPEN" });
    const loop = makeLoop({ id: "loop-X" });
    loop.triggerProvenance!.spec!.source = {
      kind: "github", ref: "7", url: "https://github.com/other/repo/issues/7",
    };
    const obs = makeObserver([loop], run, TRACKER_CONFIG); // trigger repo = acme/widget
    await obs.observeAll();
    expect(argv.length).toBe(0);
  });

  it("a gh outage (unreadable issue) is skipped, never crashes", async () => {
    const { run, argv } = fakeGh({ unreadable: true });
    const loop = makeLoop({ id: "loop-O", state: "developing" });
    const obs = makeObserver([loop], run, TRACKER_CONFIG);
    await expect(obs.observeAll()).resolves.toBeUndefined();
    expect(commentCalls(argv)).toBe(0); // read attempted, but no post on a null read.
  });

  it("a CLOSED issue is left alone by default (no comment, no reopen)", async () => {
    const { run, argv } = fakeGh({ state: "CLOSED" });
    const loop = makeLoop({ id: "loop-C", state: "converged", prRef: "pr" });
    const obs = makeObserver([loop], run, TRACKER_CONFIG);
    await obs.observeAll();
    expect(commentCalls(argv)).toBe(0);
    expect(reopenCalls(argv)).toBe(0);
  });

  it("reopenOnFailure=true reopens a CLOSED issue on a failed loop and posts terminal once", async () => {
    const ledger: string[] = [];
    const argv: string[][] = [];
    const run: ExecFileFn = vi.fn(async (_f, args: string[]) => {
      argv.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: JSON.stringify({ state: "CLOSED", comments: ledger.map((b) => ({ body: b })) }), stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "comment") {
        const idx = args.indexOf("--body-file");
        ledger.push(readFileSync(args[idx + 1], "utf8"));
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const loop = makeLoop({ id: "loop-R", state: "failed", error: "unrecoverable" });
    const obs = makeObserver([loop], run, { ...TRACKER_CONFIG, writeback: { reopenOnFailure: true } });

    await obs.observeAll();
    expect(reopenCalls(argv)).toBe(1);
    expect(ledger.filter((b) => b.includes("factory:track2:terminal:loop-R")).length).toBe(1);

    await obs.observeAll(); // idempotent — terminal marker present, no second reopen.
    expect(reopenCalls(argv)).toBe(1);
  });

  it("does nothing when the write-back sub-switch is off", async () => {
    const { run, argv } = fakeGh({ state: "OPEN" });
    const loop = makeLoop({ id: "loop-K", state: "developing" });
    const obs = makeObserver([loop], run, TRACKER_CONFIG, cfg({ writeback: false }));
    await obs.observeAll();
    expect(argv.length).toBe(0);
  });

  it("does nothing when the master switch is off", async () => {
    const { run, argv } = fakeGh({ state: "OPEN" });
    const loop = makeLoop({ id: "loop-M", state: "developing" });
    const obs = makeObserver([loop], run, TRACKER_CONFIG, cfg({ master: false }));
    await obs.observeAll();
    expect(argv.length).toBe(0);
  });
});
