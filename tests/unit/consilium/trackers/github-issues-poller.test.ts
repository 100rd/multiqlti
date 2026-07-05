/**
 * github-issues-poller.test.ts — TRACK-1 poller with a FAKE `gh` + fake storage.
 *
 * Covers the rails: a labelled issue opens a spec PR (contents PUT to a
 * docs/specs/gh-issue-<n>-… path whose frontmatter carries source.kind=github,ref)
 * + exactly ONE pickup comment + a watermark intake; a re-poll does NOT re-create
 * or re-comment; no-label-config is skipped (no gh at all); an issue with no
 * criteria (synthesiser empty) gets a need-criteria comment + NO spec PR + NO
 * intake; the master switch off ⇒ no gh; the tracker switch off ⇒ start() builds no
 * interval; a gh outage on the issue list skips the cycle (watermark untouched); a
 * targetRepoPath outside the allowlist is skipped fail-closed (no gh writes).
 */
import { describe, it, expect, vi } from "vitest";
import {
  GithubIssuesPoller,
  type GithubIssuesPollerDeps,
  type SpecSynthesizer,
} from "../../../../server/services/consilium/trackers/github-issues-poller.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

// ─── fakes ───────────────────────────────────────────────────────────────────

interface GhOpts {
  issues?: unknown[];
  existingPrs?: Array<{ url?: string }>;
  comments?: Array<{ body?: string }>;
  prUrl?: string;
  throwOn?: (args: string[]) => boolean;
}

/** A fake `gh` that serves the poll + writeSpecPr + writeback chains, recording argv. */
function fakeGh(opts: GhOpts): { run: ExecFileFn; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    if (opts.throwOn?.(args)) throw new Error("gh boom");
    const json = (obj: unknown) => ({ stdout: JSON.stringify(obj), stderr: "" });

    if (args[0] === "issue" && args[1] === "list") return json(opts.issues ?? []);
    if (args[0] === "issue" && args[1] === "view") return json({ comments: opts.comments ?? [] });
    if (args[0] === "issue" && args[1] === "comment") return { stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") return json(opts.existingPrs ?? []);
    if (args[0] === "repo" && args[1] === "view") return json({ defaultBranchRef: { name: "main" } });
    if (args[0] === "api") {
      if (args.indexOf("--method") === -1) return json({ object: { sha: "basesha" } });
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "create") {
      return { stdout: `${opts.prUrl ?? "https://github.com/acme/widget/pull/7"}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, argv };
}

function trackerTrigger(config?: Partial<TrackerEventTriggerConfig>): TriggerRow {
  const full: TrackerEventTriggerConfig = {
    tracker: "github",
    repo: "acme/widget",
    targetRepoPath: "/repo/widget",
    filter: { label: "factory" },
    specStatus: "ready",
    ...config,
  };
  return {
    id: "trk-1",
    projectId: "proj-1",
    pipelineId: null,
    type: "tracker_event",
    config: JSON.parse(JSON.stringify(full)) as TrackerEventTriggerConfig,
    secretEncrypted: null,
    enabled: true,
    lastTriggeredAt: null,
    suppressedCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as TriggerRow;
}

function cfg(masterOn: boolean, trackerOn = true, pollIntervalSec = 300): () => AppConfig {
  return () =>
    ({
      features: { triggers: { enabled: masterOn, tracker: { enabled: trackerOn, pollIntervalSec } } },
    }) as unknown as AppConfig;
}

interface HarnessOpts {
  trigger: TriggerRow;
  gh: ExecFileFn;
  masterOn?: boolean;
  trackerOn?: boolean;
  allowedRepoPaths?: () => string[];
  synthesizer?: SpecSynthesizer;
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  logs?: string[];
}

function harness(opts: HarnessOpts) {
  let stored = opts.trigger;
  const updates: Array<Partial<TriggerRow>> = [];
  const deps: GithubIssuesPollerDeps = {
    getEnabledTriggersByType: async () => [stored],
    runInProject: async (_pid, fn) => fn(),
    getTrigger: async () => stored,
    updateTrigger: async (_id, u) => {
      updates.push(u);
      if (u.config) stored = { ...stored, config: u.config } as TriggerRow;
      return stored;
    },
    config: cfg(opts.masterOn ?? true, opts.trackerOn ?? true),
    allowedRepoPaths: opts.allowedRepoPaths ?? (() => ["/repo/widget"]),
    synthesizer: opts.synthesizer,
    runGh: opts.gh,
    gitRemoteUrl: opts.gitRemoteUrl ?? (async () => "https://github.com/acme/widget.git"),
    log: (m) => opts.logs?.push(m),
    now: () => 0,
  };
  return { poller: new GithubIssuesPoller(deps), updates };
}

const SHAPED_ISSUE = {
  number: 1,
  title: "Add rate limiting",
  url: "https://github.com/acme/widget/issues/1",
  labels: [{ name: "factory" }],
  body: "## Problem\nNo limit.\n\n## Acceptance Criteria\n- [ ] returns 429 over 100 rpm\n- [ ] resets after window",
};

const count = (argv: string[][], pred: (a: string[]) => boolean) => argv.filter(pred).length;
const isPrCreate = (a: string[]) => a[0] === "pr" && a[1] === "create";
const isComment = (a: string[]) => a[0] === "issue" && a[1] === "comment";
const putContents = (a: string[]) => a[0] === "api" && a.includes("PUT") && a.some((x) => x.startsWith("repos/acme/widget/contents/"));

/** Decode the base64 `content=` arg of a PUT contents call. */
function decodePutContent(argv: string[][]): string {
  const put = argv.find(putContents);
  if (!put) return "";
  const arg = put.find((x) => x.startsWith("content="));
  return arg ? Buffer.from(arg.slice("content=".length), "base64").toString("utf8") : "";
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("GithubIssuesPoller.pollAll", () => {
  it("labelled issue → opens a spec PR + ONE pickup comment + records intake", async () => {
    const { run, argv } = fakeGh({ issues: [SHAPED_ISSUE] });
    const { poller, updates } = harness({ trigger: trackerTrigger(), gh: run });
    await poller.pollAll();

    // A contents PUT to the deterministic docs/specs path.
    const put = argv.find(putContents);
    expect(put).toBeTruthy();
    expect(put!.some((x) => x.includes("contents/docs/specs/gh-issue-1-add-rate-limiting.md"))).toBe(true);

    // The committed spec frontmatter carries github provenance.
    const spec = decodePutContent(argv);
    expect(spec).toContain("kind: github");
    expect(spec).toContain('ref: "1"');

    expect(count(argv, isPrCreate)).toBe(1);
    expect(count(argv, isComment)).toBe(1);

    // Watermark records the intake.
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["1"]?.specPrUrl).toBe("https://github.com/acme/widget/pull/7");
  });

  it("re-poll the same issue → NO 2nd PR create, NO 2nd comment", async () => {
    const { run, argv } = fakeGh({ issues: [SHAPED_ISSUE] });
    const { poller } = harness({ trigger: trackerTrigger(), gh: run });
    await poller.pollAll();
    await poller.pollAll(); // watermark now carries the intake.
    expect(count(argv, isPrCreate)).toBe(1);
    expect(count(argv, isComment)).toBe(1);
  });

  it("no filter.label configured → skipped (issue list never called)", async () => {
    const { run, argv } = fakeGh({ issues: [SHAPED_ISSUE] });
    const { poller, updates } = harness({ trigger: trackerTrigger({ filter: {} }), gh: run });
    await poller.pollAll();
    expect(argv.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("issue with no criteria + synthesiser empty → need-criteria comment, NO spec PR, NO intake", async () => {
    const freeForm = { number: 2, title: "vague", url: "u", labels: [{ name: "factory" }], body: "please make it better" };
    const synthesizer: SpecSynthesizer = { synthesize: async () => ({ criteria: [] }) };
    const { run, argv } = fakeGh({ issues: [freeForm] });
    const { poller, updates } = harness({ trigger: trackerTrigger(), gh: run, synthesizer });
    await poller.pollAll();

    expect(count(argv, isComment)).toBe(1); // the ask-for-criteria comment
    expect(count(argv, isPrCreate)).toBe(0);
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["2"]).toBeUndefined(); // NOT recorded → re-checked next poll
  });

  it("master switch off → no gh at all", async () => {
    const { run, argv } = fakeGh({ issues: [SHAPED_ISSUE] });
    const { poller } = harness({ trigger: trackerTrigger(), gh: run, masterOn: false });
    await poller.pollAll();
    expect(argv.length).toBe(0);
  });

  it("gh outage on issue list → skip cycle, watermark untouched, no crash", async () => {
    const { run } = fakeGh({ throwOn: (a) => a[0] === "issue" && a[1] === "list" });
    const { poller, updates } = harness({ trigger: trackerTrigger(), gh: run });
    await expect(poller.pollAll()).resolves.toBeUndefined();
    expect(updates.length).toBe(0); // persistWatermark never reached
  });

  it("targetRepoPath NOT in the allowlist → skipped fail-closed (no gh)", async () => {
    const { run, argv } = fakeGh({ issues: [SHAPED_ISSUE] });
    const { poller } = harness({
      trigger: trackerTrigger(),
      gh: run,
      allowedRepoPaths: () => ["/some/other/repo"],
    });
    await poller.pollAll();
    expect(argv.length).toBe(0);
  });
});

describe("GithubIssuesPoller.start gating", () => {
  it("tracker disabled → start() builds no interval", () => {
    vi.useFakeTimers();
    try {
      const { run, argv } = fakeGh({ issues: [SHAPED_ISSUE] });
      const logs: string[] = [];
      const { poller } = harness({ trigger: trackerTrigger(), gh: run, trackerOn: false, logs });
      poller.start();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(argv.length).toBe(0);
      expect(logs.some((l) => l.includes("disabled"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracker enabled → start() logs a started poller", () => {
    vi.useFakeTimers();
    try {
      const { run } = fakeGh({ issues: [] });
      const logs: string[] = [];
      const { poller } = harness({ trigger: trackerTrigger(), gh: run, trackerOn: true, logs });
      poller.start();
      expect(logs.some((l) => l.includes("tracker poller started"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
