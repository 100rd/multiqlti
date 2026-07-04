/**
 * github-poller.test.ts — POLLING mode for github_event triggers behind NAT.
 *
 * Injects a FAKE `gh` runner (no real gh / network) + fake storage/fire seams.
 * Covers the rails from server/services/github-poller.ts:
 *   - a NEW open PR fires ONCE and sets the watermark; a re-poll at the same head
 *     does NOT re-fire (adversarial (a): watermark must persist + advance);
 *   - a dedup-suppressed fire HOLDS the watermark → retried next cycle (never lost);
 *   - the master switch (features.triggers.enabled) off → no poll, no fire, no gh;
 *   - no github remote (empty config.repository + no parseable remote) → skip + log;
 *   - push: first poll BASELINES (no fire); a head ADVANCE fires a post-merge review;
 *   - a gh outage (runner throws) degrades to a skip — never crashes the poller;
 *   - parseOwnerRepo handles BOTH scp-SSH and URL remotes (adversarial (d));
 *   - the synthesized envelope maps IDENTICALLY to the webhook path (#471 reuse).
 */
import { describe, it, expect, vi } from "vitest";
import {
  GitHubPoller,
  parseOwnerRepo,
  type GitHubPollerDeps,
} from "../../../server/services/github-poller.js";
import type { ExecFileFn } from "../../../server/services/github-status.js";
import { mapGitHubEventToReview } from "../../../server/services/consilium/github-event-map.js";
import type { TriggerFireResult } from "../../../server/services/consilium/trigger-dispatch.js";
import { runAsProject } from "../../../server/context.js";
import { withProject } from "../../../server/db.js";
import { triggers, type TriggerRow } from "../../../shared/schema.js";
import { eq } from "drizzle-orm";
import type { AppConfig, GitHubEventTriggerConfig, GitHubPollState } from "../../../shared/types.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const PUSH_1 = "d".repeat(40);
const PUSH_2 = "e".repeat(40);

/** A github_event trigger row with the given config (deep-cloned so tests don't share). */
function ghTrigger(config: Partial<GitHubEventTriggerConfig>): TriggerRow {
  const full: GitHubEventTriggerConfig = {
    repository: "acme/widget",
    events: ["pull_request"],
    action: { kind: "consilium_review", preset: "diff-pr-review", repoPath: "/repo/widget" },
    ...config,
  };
  return {
    id: "trig-1",
    projectId: "proj-1",
    pipelineId: null,
    type: "github_event",
    config: JSON.parse(JSON.stringify(full)) as GitHubEventTriggerConfig,
    secretEncrypted: null,
    enabled: true,
    lastTriggeredAt: null,
    suppressedCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as TriggerRow;
}

/** Minimal AppConfig accessor with the two switches under test. */
function cfg(masterOn: boolean, pollOn = true, intervalSec = 300): () => AppConfig {
  return () =>
    ({
      features: {
        triggers: {
          enabled: masterOn,
          githubPolling: { enabled: pollOn, intervalSec },
        },
      },
    }) as unknown as AppConfig;
}

interface GhResponses {
  prs?: unknown;                       // gh pr list → json array
  defaultBranch?: string;              // gh repo view → defaultBranchRef.name
  branchHead?: string;                 // gh api branches → commit.sha
  throwOn?: (args: string[]) => boolean;
}

/** A fake `gh` runner that answers by argv; records calls. */
function fakeGh(r: GhResponses): { run: ExecFileFn; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    if (r.throwOn?.(args)) throw new Error("gh boom");
    if (args[0] === "pr" && args[1] === "list") {
      return { stdout: JSON.stringify(r.prs ?? []), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return { stdout: JSON.stringify({ defaultBranchRef: { name: r.defaultBranch ?? "main" } }), stderr: "" };
    }
    if (args[0] === "api") {
      return { stdout: JSON.stringify({ commit: { sha: r.branchHead ?? "" } }), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, argv };
}

/** Build a poller + capture harness around one trigger. */
function harness(opts: {
  trigger: TriggerRow;
  gh: ExecFileFn;
  masterOn?: boolean;
  fireResult?: TriggerFireResult | ((payload: unknown) => TriggerFireResult);
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
}) {
  let stored = opts.trigger;
  const firePayloads: unknown[] = [];
  const fire = vi.fn(async (_t: TriggerRow, payload: unknown): Promise<TriggerFireResult> => {
    firePayloads.push(payload);
    const r = opts.fireResult ?? "launched";
    return typeof r === "function" ? r(payload) : r;
  });
  const updates: Array<Partial<TriggerRow>> = [];
  const projectIds: string[] = [];
  const deps: GitHubPollerDeps = {
    getEnabledTriggersByType: async () => [stored],
    // Pass-through project context (real ALS wiring is covered by a separate test).
    runInProject: async (pid, fn) => {
      projectIds.push(pid);
      return fn();
    },
    getTrigger: async () => stored,
    updateTrigger: async (_id, u) => {
      updates.push(u);
      // Reflect the watermark write so a follow-up poll sees it (persistence).
      if (u.config) stored = { ...stored, config: u.config };
      return stored;
    },
    fireTrigger: fire,
    config: cfg(opts.masterOn ?? true),
    runGh: opts.gh,
    gitRemoteUrl: opts.gitRemoteUrl,
    log: () => {},
    now: () => 0,
  };
  return {
    poller: new GitHubPoller(deps),
    fire,
    firePayloads,
    updates,
    projectIds,
    lastWatermark: (): GitHubPollState | undefined =>
      (stored.config as GitHubEventTriggerConfig).pollState,
  };
}

describe("parseOwnerRepo (adversarial (d): SSH + HTTPS remotes)", () => {
  it("parses scp-style SSH remotes", () => {
    expect(parseOwnerRepo("git@github.com:acme/widget.git")).toBe("acme/widget");
    expect(parseOwnerRepo("git@github.com:acme/widget")).toBe("acme/widget");
  });
  it("parses URL remotes (https / ssh / git), stripping .git and trailing slash", () => {
    expect(parseOwnerRepo("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(parseOwnerRepo("https://github.com/acme/widget")).toBe("acme/widget");
    expect(parseOwnerRepo("https://github.com/acme/widget/")).toBe("acme/widget");
    expect(parseOwnerRepo("ssh://git@github.com/acme/widget.git")).toBe("acme/widget");
    expect(parseOwnerRepo("git://github.com/acme/widget.git")).toBe("acme/widget");
  });
  it("returns null for junk / non-remote strings", () => {
    expect(parseOwnerRepo("")).toBeNull();
    expect(parseOwnerRepo("not-a-remote")).toBeNull();
    expect(parseOwnerRepo("https://github.com/acme")).toBeNull();
  });
});

describe("GitHubPoller — pull_request polling", () => {
  const openPr = { number: 42, title: "Add thing", headRefOid: HEAD_A, baseRefOid: BASE_SHA, updatedAt: "2026-07-01T00:00:00Z" };

  it("fires once for a new open PR and sets the watermark", async () => {
    const h = harness({ trigger: ghTrigger({}), gh: fakeGh({ prs: [openPr] }).run });
    await h.poller.pollAll();

    expect(h.fire).toHaveBeenCalledTimes(1);
    expect(h.lastWatermark()?.prHeads).toEqual({ "42": HEAD_A });

    // The synthesized envelope is the SAME { event, delivery, payload } the webhook
    // receiver hands fireTrigger; env.payload IS the raw github body. Feeding it to
    // the SAME pure mapper proves webhook and polling produce IDENTICAL loops (#471).
    const env = h.firePayloads[0] as { event: string; payload: unknown };
    expect(env.event).toBe("pull_request");
    const mapped = mapGitHubEventToReview("pull_request", env.payload);
    expect(mapped.kind).toBe("review");
    if (mapped.kind === "review") {
      expect(mapped.mapping.preset).toBe("diff-pr-review");
      expect(mapped.mapping.ref).toBe(HEAD_A);
      expect(mapped.mapping.baselineCommit).toBe(BASE_SHA);
    }
  });

  it("does NOT re-fire when the watermark already matches the PR head", async () => {
    const trigger = ghTrigger({ pollState: { prHeads: { "42": HEAD_A } } });
    const h = harness({ trigger, gh: fakeGh({ prs: [openPr] }).run });
    await h.poller.pollAll();
    expect(h.fire).not.toHaveBeenCalled();
  });

  it("re-fires when the PR head ADVANCES past the watermark", async () => {
    const trigger = ghTrigger({ pollState: { prHeads: { "42": HEAD_A } } });
    const movedPr = { ...openPr, headRefOid: HEAD_B };
    const h = harness({ trigger, gh: fakeGh({ prs: [movedPr] }).run });
    await h.poller.pollAll();
    expect(h.fire).toHaveBeenCalledTimes(1);
    const env = h.firePayloads[0] as { payload: { action: string } };
    expect(env.payload.action).toBe("synchronize"); // head changed → synchronize
    expect(h.lastWatermark()?.prHeads).toEqual({ "42": HEAD_B });
  });

  it("HOLDS the watermark on a dedup-suppressed fire → retried next cycle (adversarial (a)/(b))", async () => {
    const h = harness({
      trigger: ghTrigger({}),
      gh: fakeGh({ prs: [openPr] }).run,
      fireResult: "skipped-dedup",
    });
    await h.poller.pollAll();
    expect(h.fire).toHaveBeenCalledTimes(1);
    // Watermark NOT advanced — the PR is retried, not lost.
    expect(h.lastWatermark()?.prHeads?.["42"]).toBeUndefined();
  });

  it("skips a PR with an unusable head/base sha (no fire)", async () => {
    const badPr = { number: 7, title: "x", headRefOid: "not-a-sha", baseRefOid: BASE_SHA };
    const h = harness({ trigger: ghTrigger({}), gh: fakeGh({ prs: [badPr] }).run });
    await h.poller.pollAll();
    expect(h.fire).not.toHaveBeenCalled();
  });
});

describe("GitHubPoller — push polling", () => {
  const pushTrigger = () => ghTrigger({ events: ["push"] });

  it("BASELINES the default-branch head on first poll (no fire)", async () => {
    const h = harness({
      trigger: pushTrigger(),
      gh: fakeGh({ defaultBranch: "main", branchHead: PUSH_1 }).run,
    });
    await h.poller.pollAll();
    expect(h.fire).not.toHaveBeenCalled();
    expect(h.lastWatermark()?.lastPushSha).toBe(PUSH_1);
  });

  it("fires a post-merge review when the default-branch head ADVANCES", async () => {
    const trigger = ghTrigger({ events: ["push"], pollState: { lastPushSha: PUSH_1 } });
    const h = harness({
      trigger,
      gh: fakeGh({ defaultBranch: "main", branchHead: PUSH_2 }).run,
    });
    await h.poller.pollAll();
    expect(h.fire).toHaveBeenCalledTimes(1);
    const env = h.firePayloads[0] as { event: string; payload: unknown };
    const mapped = mapGitHubEventToReview("push", env.payload);
    expect(mapped.kind).toBe("review");
    if (mapped.kind === "review") {
      expect(mapped.mapping.preset).toBe("diff-pr-review"); // before..after
      expect(mapped.mapping.ref).toBe(PUSH_2);
      expect(mapped.mapping.baselineCommit).toBe(PUSH_1);
    }
    expect(h.lastWatermark()?.lastPushSha).toBe(PUSH_2);
  });

  it("does NOT re-fire when the head is unchanged", async () => {
    const trigger = ghTrigger({ events: ["push"], pollState: { lastPushSha: PUSH_1 } });
    const h = harness({
      trigger,
      gh: fakeGh({ defaultBranch: "main", branchHead: PUSH_1 }).run,
    });
    await h.poller.pollAll();
    expect(h.fire).not.toHaveBeenCalled();
  });
});

describe("GitHubPoller — rails", () => {
  it("master switch off → no poll, no fire, no gh call", async () => {
    const gh = fakeGh({ prs: [{ number: 1, headRefOid: HEAD_A, baseRefOid: BASE_SHA }] });
    const h = harness({ trigger: ghTrigger({}), gh: gh.run, masterOn: false });
    await h.poller.pollAll();
    expect(h.fire).not.toHaveBeenCalled();
    expect(gh.argv.length).toBe(0);
  });

  it("no github remote (empty repository + no parseable remote) → skip, no fire, no gh call", async () => {
    const gh = fakeGh({ prs: [] });
    const h = harness({
      trigger: ghTrigger({ repository: "" }),
      gh: gh.run,
      gitRemoteUrl: async () => null,
    });
    await h.poller.pollAll();
    expect(h.fire).not.toHaveBeenCalled();
    expect(gh.argv.length).toBe(0);
  });

  it("derives owner/repo from the git remote when config.repository is empty", async () => {
    const gh = fakeGh({ prs: [{ number: 9, headRefOid: HEAD_A, baseRefOid: BASE_SHA }] });
    const h = harness({
      trigger: ghTrigger({ repository: "" }),
      gh: gh.run,
      gitRemoteUrl: async () => "git@github.com:acme/widget.git",
    });
    await h.poller.pollAll();
    expect(h.fire).toHaveBeenCalledTimes(1);
    // gh pr list was invoked against the derived owner/repo.
    const prList = gh.argv.find((a) => a[0] === "pr" && a[1] === "list");
    expect(prList).toContain("acme/widget");
  });

  it("scopes the per-trigger poll to the trigger's OWN project (runInProject)", async () => {
    const h = harness({
      trigger: ghTrigger({ pollState: { prHeads: {} } }),
      gh: fakeGh({ prs: [{ number: 3, headRefOid: HEAD_A, baseRefOid: BASE_SHA }] }).run,
    });
    await h.poller.pollAll();
    expect(h.projectIds).toEqual(["proj-1"]); // storage ran inside runAsProject(proj-1)
  });

  it("skips a project-less trigger (cannot scope storage / launch a review)", async () => {
    const gh = fakeGh({ prs: [{ number: 1, headRefOid: HEAD_A, baseRefOid: BASE_SHA }] });
    const trigger = { ...ghTrigger({}), projectId: null } as TriggerRow;
    const h = harness({ trigger, gh: gh.run });
    await h.poller.pollAll();
    expect(h.fire).not.toHaveBeenCalled();
    expect(h.projectIds).toEqual([]); // never entered a project context
    expect(gh.argv.length).toBe(0);
  });

  it("a gh outage degrades to a skip — never throws, never fires", async () => {
    const gh = fakeGh({ throwOn: () => true });
    const h = harness({ trigger: ghTrigger({}), gh: gh.run });
    await expect(h.poller.pollAll()).resolves.toBeUndefined();
    expect(h.fire).not.toHaveBeenCalled();
  });

  it("one trigger's failure does not stop the cycle (guarded per trigger)", async () => {
    // getEnabledTriggersByType returns two triggers; the first throws in fire.
    const gh = fakeGh({ prs: [{ number: 1, headRefOid: HEAD_A, baseRefOid: BASE_SHA }] });
    const t1 = ghTrigger({});
    const fireCalls: string[] = [];
    const deps: GitHubPollerDeps = {
      getEnabledTriggersByType: async () => [t1, { ...t1, id: "trig-2" } as TriggerRow],
      runInProject: async (_pid, fn) => fn(),
      getTrigger: async (id) => ({ ...t1, id } as TriggerRow),
      updateTrigger: async () => t1,
      fireTrigger: async (t) => {
        fireCalls.push(t.id);
        if (t.id === "trig-1") throw new Error("first trigger blows up");
        return "launched";
      },
      config: cfg(true),
      runGh: gh.run,
      log: () => {},
      now: () => 0,
    };
    const poller = new GitHubPoller(deps);
    await expect(poller.pollAll()).resolves.toBeUndefined();
    // Both triggers were attempted despite the first throwing.
    expect(fireCalls).toEqual(["trig-1", "trig-2"]);
  });
});

// ─── REAL context path (non-mocked withProject) — regression guard ─────────────
//
// The #471-style tests mocked storage so the project-scoped `withProject` gate
// was never exercised — that hid a crash where background/webhook callers with no
// ALS context throw "no request context". These tests route the poller's storage
// through the REAL `withProject` (server/db.ts) + REAL `runAsProject`
// (server/context.ts) so a missing/incorrect context cannot regress silently.
describe("GitHubPoller — real project-context path (withProject regression)", () => {
  // A storage stub whose reads/writes go through the REAL project-scope gate.
  function contextCheckedStorage(trigger: TriggerRow) {
    let stored = trigger;
    return {
      getTrigger: async (id: string) => {
        // Throws "no request context" if called outside runAsProject/runAsSystem.
        withProject(triggers, eq(triggers.id, id));
        return stored;
      },
      updateTrigger: async (id: string, u: Partial<TriggerRow>) => {
        withProject(triggers, eq(triggers.id, id));
        if (u.config) stored = { ...stored, config: u.config } as TriggerRow;
        return stored;
      },
      current: () => stored,
    };
  }

  const openPr = { number: 5, title: "ctx", headRefOid: HEAD_A, baseRefOid: BASE_SHA };

  it("does NOT throw when per-trigger storage runs inside the REAL runAsProject", async () => {
    const trigger = ghTrigger({});
    const store = contextCheckedStorage(trigger);
    const gh = fakeGh({ prs: [openPr] });
    const poller = new GitHubPoller({
      getEnabledTriggersByType: async () => [trigger],
      runInProject: runAsProject, // REAL ALS context
      getTrigger: store.getTrigger,
      updateTrigger: store.updateTrigger,
      fireTrigger: async () => "launched",
      config: cfg(true),
      runGh: gh.run,
      log: () => {},
      now: () => 0,
    });
    await expect(poller.pollAll()).resolves.toBeUndefined();
    // The watermark WAS written through the real project-scope gate.
    expect((store.current().config as GitHubEventTriggerConfig).pollState?.prHeads).toEqual({
      "5": HEAD_A,
    });
  });

  it("PROVES the guard bites: the same storage throws 'no request context' with a pass-through runInProject", async () => {
    const trigger = ghTrigger({});
    const store = contextCheckedStorage(trigger);
    const gh = fakeGh({ prs: [openPr] });
    const poller = new GitHubPoller({
      getEnabledTriggersByType: async () => [trigger],
      // BROKEN wiring: does NOT establish an ALS context (the original bug shape).
      runInProject: async (_pid, fn) => fn(),
      getTrigger: store.getTrigger,
      updateTrigger: store.updateTrigger,
      fireTrigger: async () => "launched",
      config: cfg(true),
      runGh: gh.run,
      log: () => {},
      now: () => 0,
    });
    // pollAll swallows per-trigger errors, so assert the write never landed
    // (persistWatermark threw inside the guarded cycle → watermark unchanged).
    await poller.pollAll();
    expect((store.current().config as GitHubEventTriggerConfig).pollState).toBeUndefined();
  });
});
