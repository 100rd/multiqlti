/**
 * bitbucket-issues-poller.test.ts — TRACK-4 poller with a FAKE Bitbucket transport +
 * FAKE `gh`. Mirrors jira/gitlab poller tests: a component-matched Bitbucket issue → the
 * SHARED synth → a spec PR (contents PUT to a docs/specs/bitbucket-<id>-… path whose
 * frontmatter carries source.kind=bitbucket,ref=<id>) + exactly ONE Bitbucket pickup
 * comment + a watermark intake; a re-poll dedups; an issue whose component doesn't match
 * is skipped (defence-in-depth); a free-form issue with no criteria → a need-criteria
 * comment + NO PR + NO intake; the master switch off ⇒ no Bitbucket calls; a Bitbucket
 * outage on the list skips the cycle (watermark untouched); a non-allowlisted
 * targetRepoPath is fail-closed.
 */
import { describe, it, expect, vi } from "vitest";
import {
  BitbucketIssuesPoller,
  type BitbucketIssuesPollerDeps,
  type TicketSynthesizer,
} from "../../../../server/services/consilium/trackers/bitbucket-issues-poller.js";
import type { BitbucketHttpFn, BitbucketHttpResult } from "../../../../server/services/consilium/trackers/bitbucket-exec.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

interface BbOpts {
  issues?: unknown[];
  comments?: Array<{ content?: { raw?: string } }>;
  listStatus?: number;
}

/** A fake Bitbucket transport for the list + comments (idempotency read + post) chain. */
function fakeBitbucket(opts: BbOpts): { http: BitbucketHttpFn; calls: Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const http: BitbucketHttpFn = vi.fn(async (req): Promise<BitbucketHttpResult> => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    const json = (obj: unknown, status = 200): BitbucketHttpResult => ({ status, body: JSON.stringify(obj) });
    const path = new URL(req.url).pathname;
    if (path.endsWith("/comments") && req.method === "GET") return json({ values: opts.comments ?? [] });
    if (path.endsWith("/comments") && req.method === "POST") return { status: 201, body: "{}" };
    if (path.endsWith("/issues")) {
      if (opts.listStatus && opts.listStatus >= 400) return { status: opts.listStatus, body: "err" };
      return json({ values: opts.issues ?? [] });
    }
    return json({});
  });
  return { http, calls };
}

/** A fake `gh` that serves the writeSpecPr chain (no issue list — Bitbucket does the watch). */
function fakeGh(prUrl = "https://github.com/acme/widget/pull/9"): { run: ExecFileFn; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    const json = (obj: unknown) => ({ stdout: JSON.stringify(obj), stderr: "" });
    if (args[0] === "pr" && args[1] === "list") return json([]);
    if (args[0] === "repo" && args[1] === "view") return json({ defaultBranchRef: { name: "main" } });
    if (args[0] === "api") {
      if (args.indexOf("--method") === -1) return json({ object: { sha: "basesha" } });
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "create") return { stdout: `${prUrl}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  });
  return { run, argv };
}

function bbTrigger(config?: Partial<TrackerEventTriggerConfig>): TriggerRow {
  const full: TrackerEventTriggerConfig = {
    tracker: "bitbucket",
    workspace: "acme",
    repoSlug: "tracker-repo",
    repo: "acme/widget",
    targetRepoPath: "/repo/widget",
    filter: { label: "agent" },
    specStatus: "ready",
    ...config,
  };
  return {
    id: "trk-bb-1",
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
  bb: BitbucketHttpFn;
  gh: ExecFileFn;
  masterOn?: boolean;
  trackerOn?: boolean;
  allowedRepoPaths?: () => string[];
  synthesizer?: TicketSynthesizer;
  logs?: string[];
}

function harness(opts: HarnessOpts) {
  let stored = opts.trigger;
  const updates: Array<Partial<TriggerRow>> = [];
  const deps: BitbucketIssuesPollerDeps = {
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
    bitbucketHttp: opts.bb,
    bitbucketAuth: { username: "bot", appPassword: "secret" },
    gitRemoteUrl: async () => "https://github.com/acme/widget.git",
    log: (m) => opts.logs?.push(m),
    now: () => 0,
  };
  return { poller: new BitbucketIssuesPoller(deps), updates };
}

const SHAPED_ISSUE = {
  id: 42,
  title: "Add rate limiting",
  content: { raw: "## Problem\nNo limit.\n\n## Acceptance Criteria\n- returns 429 over 100 rpm\n- resets after window" },
  state: "new",
  kind: "task",
  component: { name: "agent" },
  updated_on: "2026-01-02T10:00:00.000000+00:00",
  links: { html: { href: "https://bitbucket.org/acme/tracker-repo/issues/42" } },
};

const count = (argv: string[][], pred: (a: string[]) => boolean) => argv.filter(pred).length;
const isPrCreate = (a: string[]) => a[0] === "pr" && a[1] === "create";
const putContents = (a: string[]) =>
  a[0] === "api" && a.includes("PUT") && a.some((x) => x.startsWith("repos/acme/widget/contents/"));

function decodePutContent(argv: string[][]): string {
  const put = argv.find(putContents);
  if (!put) return "";
  const arg = put.find((x) => x.startsWith("content="));
  return arg ? Buffer.from(arg.slice("content=".length), "base64").toString("utf8") : "";
}

const commentPosts = (calls: Array<{ method: string; url: string }>) =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/comments")).length;

describe("BitbucketIssuesPoller.pollAll", () => {
  it("component-matched issue → spec PR (source.kind=bitbucket,ref=id) + ONE pickup comment + intake", async () => {
    const { http, calls } = fakeBitbucket({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: bbTrigger(), bb: http, gh: run });
    await poller.pollAll();

    const put = argv.find(putContents);
    expect(put).toBeTruthy();
    expect(put!.some((x) => x.includes("contents/docs/specs/bitbucket-42-add-rate-limiting.md"))).toBe(true);

    const spec = decodePutContent(argv);
    expect(spec).toContain("kind: bitbucket");
    expect(spec).toContain('ref: "42"');

    expect(count(argv, isPrCreate)).toBe(1);
    expect(commentPosts(calls)).toBe(1);

    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["42"]?.specPrUrl).toBe("https://github.com/acme/widget/pull/9");
  });

  it("re-poll the same issue → NO 2nd PR, NO 2nd comment (watermark dedup)", async () => {
    const { http, calls } = fakeBitbucket({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: bbTrigger(), bb: http, gh: run });
    await poller.pollAll();
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(1);
    expect(commentPosts(calls)).toBe(1);
  });

  it("component-mismatched issue → skipped (defence-in-depth)", async () => {
    const other = { ...SHAPED_ISSUE, id: 43, component: { name: "other" }, kind: "bug" };
    const { http } = fakeBitbucket({ issues: [other] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: bbTrigger(), bb: http, gh: run });
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(0);
  });

  it("free-form issue + synthesiser empty → need-criteria comment, NO spec PR, NO intake", async () => {
    const freeForm = { id: 44, title: "vague", content: { raw: "please make it better" }, state: "new", component: { name: "agent" } };
    const synthesizer: TicketSynthesizer = { synthesize: async () => ({ criteria: [] }) };
    const { http, calls } = fakeBitbucket({ issues: [freeForm] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: bbTrigger(), bb: http, gh: run, synthesizer });
    await poller.pollAll();

    expect(commentPosts(calls)).toBe(1);
    expect(count(argv, isPrCreate)).toBe(0);
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["44"]).toBeUndefined();
  });

  it("no filter.label configured → skipped (no Bitbucket call at all)", async () => {
    const { http, calls } = fakeBitbucket({ issues: [SHAPED_ISSUE] });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: bbTrigger({ filter: {} }), bb: http, gh: run });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("master switch off → no Bitbucket calls at all", async () => {
    const { http, calls } = fakeBitbucket({ issues: [SHAPED_ISSUE] });
    const { run } = fakeGh();
    const { poller } = harness({ trigger: bbTrigger(), bb: http, gh: run, masterOn: false });
    await poller.pollAll();
    expect(calls.length).toBe(0);
  });

  it("Bitbucket outage on the list → skip cycle, watermark untouched, no crash", async () => {
    const { http } = fakeBitbucket({ listStatus: 500 });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: bbTrigger(), bb: http, gh: run });
    await expect(poller.pollAll()).resolves.toBeUndefined();
    expect(updates.length).toBe(0);
  });

  it("targetRepoPath NOT in the allowlist → skipped fail-closed (no Bitbucket, no gh)", async () => {
    const { http, calls } = fakeBitbucket({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller } = harness({
      trigger: bbTrigger(),
      bb: http,
      gh: run,
      allowedRepoPaths: () => ["/some/other/repo"],
    });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(argv.length).toBe(0);
  });

  it("a gitlab-configured trigger is ignored by the bitbucket poller", async () => {
    const { http, calls } = fakeBitbucket({ issues: [SHAPED_ISSUE] });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: bbTrigger({ tracker: "gitlab" }), bb: http, gh: run });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(updates.length).toBe(0);
  });
});

describe("BitbucketIssuesPoller.start gating", () => {
  it("tracker disabled → start() builds no interval", () => {
    vi.useFakeTimers();
    try {
      const { http } = fakeBitbucket({ issues: [SHAPED_ISSUE] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: bbTrigger(), bb: http, gh: run, trackerOn: false, logs });
      poller.start();
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(logs.some((l) => l.includes("disabled"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracker enabled → start() logs a started poller", () => {
    vi.useFakeTimers();
    try {
      const { http } = fakeBitbucket({ issues: [] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: bbTrigger(), bb: http, gh: run, trackerOn: true, logs });
      poller.start();
      expect(logs.some((l) => l.includes("bitbucket tracker poller started"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
