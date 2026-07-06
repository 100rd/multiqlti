/**
 * gitlab-issues-poller.test.ts — TRACK-4 poller with a FAKE GitLab transport + FAKE `gh`.
 *
 * Mirrors jira-issues-poller.test: a labelled GitLab issue → the SHARED synth → a spec PR
 * (contents PUT to a docs/specs/gitlab-<iid>-… path whose frontmatter carries
 * source.kind=gitlab,ref=<iid>) + exactly ONE GitLab pickup note + a watermark intake; a
 * re-poll does NOT re-create or re-note (dedup); an unlabelled issue is skipped
 * (defence-in-depth); a free-form issue with no criteria → a need-criteria note + NO PR +
 * NO intake; the master switch off ⇒ no GitLab calls; the tracker switch off ⇒ start()
 * builds no interval; a GitLab outage on the list skips the cycle (watermark untouched);
 * a non-allowlisted targetRepoPath is fail-closed.
 */
import { describe, it, expect, vi } from "vitest";
import {
  GitlabIssuesPoller,
  type GitlabIssuesPollerDeps,
  type TicketSynthesizer,
} from "../../../../server/services/consilium/trackers/gitlab-issues-poller.js";
import type { GitlabHttpFn, GitlabHttpResult } from "../../../../server/services/consilium/trackers/gitlab-exec.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

interface GitlabOpts {
  issues?: unknown[];
  notes?: Array<{ body?: string }>;
  listStatus?: number;
}

/** A fake GitLab transport for the list + notes (idempotency read + post) chain. */
function fakeGitlab(opts: GitlabOpts): { http: GitlabHttpFn; calls: Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const http: GitlabHttpFn = vi.fn(async (req): Promise<GitlabHttpResult> => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    const json = (obj: unknown, status = 200): GitlabHttpResult => ({ status, body: JSON.stringify(obj) });
    const path = new URL(req.url).pathname;
    if (path.endsWith("/notes") && req.method === "GET") return json(opts.notes ?? []);
    if (path.endsWith("/notes") && req.method === "POST") return { status: 201, body: "{}" };
    if (path.endsWith("/issues")) {
      if (opts.listStatus && opts.listStatus >= 400) return { status: opts.listStatus, body: "err" };
      return json(opts.issues ?? []);
    }
    return json({});
  });
  return { http, calls };
}

/** A fake `gh` that serves the writeSpecPr chain (no issue list — GitLab does the watch). */
function fakeGh(prUrl = "https://github.com/acme/widget/pull/7"): { run: ExecFileFn; argv: string[][] } {
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

function gitlabTrigger(config?: Partial<TrackerEventTriggerConfig>): TriggerRow {
  const full: TrackerEventTriggerConfig = {
    tracker: "gitlab",
    baseUrl: "https://gitlab.com",
    gitlabProject: "group/widget",
    repo: "acme/widget",
    targetRepoPath: "/repo/widget",
    filter: { label: "agent" },
    specStatus: "ready",
    ...config,
  };
  return {
    id: "trk-gitlab-1",
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
  gitlab: GitlabHttpFn;
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
  const deps: GitlabIssuesPollerDeps = {
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
    gitlabHttp: opts.gitlab,
    gitlabAuth: { token: "secret" },
    gitRemoteUrl: async () => "https://github.com/acme/widget.git",
    log: (m) => opts.logs?.push(m),
    now: () => 0,
  };
  return { poller: new GitlabIssuesPoller(deps), updates };
}

const SHAPED_ISSUE = {
  iid: 1,
  title: "Add rate limiting",
  description: "## Problem\nNo limit.\n\n## Acceptance Criteria\n- returns 429 over 100 rpm\n- resets after window",
  labels: ["agent"],
  web_url: "https://gitlab.com/group/widget/-/issues/1",
  updated_at: "2026-01-02T10:00:00.000Z",
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

const notePosts = (calls: Array<{ method: string; url: string }>) =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/notes")).length;

describe("GitlabIssuesPoller.pollAll", () => {
  it("labelled issue → spec PR (source.kind=gitlab,ref=iid) + ONE GitLab pickup note + intake", async () => {
    const { http, calls } = fakeGitlab({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: gitlabTrigger(), gitlab: http, gh: run });
    await poller.pollAll();

    const put = argv.find(putContents);
    expect(put).toBeTruthy();
    expect(put!.some((x) => x.includes("contents/docs/specs/gitlab-1-add-rate-limiting.md"))).toBe(true);

    const spec = decodePutContent(argv);
    expect(spec).toContain("kind: gitlab");
    expect(spec).toContain('ref: "1"');

    expect(count(argv, isPrCreate)).toBe(1);
    expect(notePosts(calls)).toBe(1);

    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["1"]?.specPrUrl).toBe("https://github.com/acme/widget/pull/7");
  });

  it("re-poll the same issue → NO 2nd PR, NO 2nd note (watermark dedup)", async () => {
    const { http, calls } = fakeGitlab({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: gitlabTrigger(), gitlab: http, gh: run });
    await poller.pollAll();
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(1);
    expect(notePosts(calls)).toBe(1);
  });

  it("unlabelled issue → skipped (no spec PR, defence-in-depth)", async () => {
    const unlabelled = { ...SHAPED_ISSUE, iid: 2, labels: ["other"] };
    const { http } = fakeGitlab({ issues: [unlabelled] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: gitlabTrigger(), gitlab: http, gh: run });
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(0);
  });

  it("free-form issue + synthesiser empty → need-criteria note, NO spec PR, NO intake", async () => {
    const freeForm = { iid: 3, title: "vague", description: "please make it better", labels: ["agent"] };
    const synthesizer: TicketSynthesizer = { synthesize: async () => ({ criteria: [] }) };
    const { http, calls } = fakeGitlab({ issues: [freeForm] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: gitlabTrigger(), gitlab: http, gh: run, synthesizer });
    await poller.pollAll();

    expect(notePosts(calls)).toBe(1);
    expect(count(argv, isPrCreate)).toBe(0);
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["3"]).toBeUndefined();
  });

  it("no filter.label configured → skipped (no GitLab call at all)", async () => {
    const { http, calls } = fakeGitlab({ issues: [SHAPED_ISSUE] });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: gitlabTrigger({ filter: {} }), gitlab: http, gh: run });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("master switch off → no GitLab calls at all", async () => {
    const { http, calls } = fakeGitlab({ issues: [SHAPED_ISSUE] });
    const { run } = fakeGh();
    const { poller } = harness({ trigger: gitlabTrigger(), gitlab: http, gh: run, masterOn: false });
    await poller.pollAll();
    expect(calls.length).toBe(0);
  });

  it("GitLab outage on the list → skip cycle, watermark untouched, no crash", async () => {
    const { http } = fakeGitlab({ listStatus: 500 });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: gitlabTrigger(), gitlab: http, gh: run });
    await expect(poller.pollAll()).resolves.toBeUndefined();
    expect(updates.length).toBe(0);
  });

  it("targetRepoPath NOT in the allowlist → skipped fail-closed (no GitLab, no gh)", async () => {
    const { http, calls } = fakeGitlab({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller } = harness({
      trigger: gitlabTrigger(),
      gitlab: http,
      gh: run,
      allowedRepoPaths: () => ["/some/other/repo"],
    });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(argv.length).toBe(0);
  });

  it("a bitbucket-configured trigger is ignored by the gitlab poller", async () => {
    const { http, calls } = fakeGitlab({ issues: [SHAPED_ISSUE] });
    const { run } = fakeGh();
    const { poller, updates } = harness({
      trigger: gitlabTrigger({ tracker: "bitbucket" }),
      gitlab: http,
      gh: run,
    });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(updates.length).toBe(0);
  });
});

describe("GitlabIssuesPoller.start gating", () => {
  it("tracker disabled → start() builds no interval", () => {
    vi.useFakeTimers();
    try {
      const { http } = fakeGitlab({ issues: [SHAPED_ISSUE] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: gitlabTrigger(), gitlab: http, gh: run, trackerOn: false, logs });
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
      const { http } = fakeGitlab({ issues: [] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: gitlabTrigger(), gitlab: http, gh: run, trackerOn: true, logs });
      poller.start();
      expect(logs.some((l) => l.includes("gitlab tracker poller started"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
