/**
 * jira-issues-poller.test.ts — TRACK-3 poller with a FAKE Jira transport + FAKE `gh`.
 *
 * Covers the rails, mirroring github-issues-poller.test: a JQL-matched issue → the
 * SHARED synth → a spec PR (contents PUT to a docs/specs/jira-<KEY>-… path whose
 * frontmatter carries source.kind=jira,ref=<KEY>) + exactly ONE Jira pickup comment +
 * a watermark intake; a re-poll does NOT re-create or re-comment; an unlabelled issue
 * is skipped (defence-in-depth); a free-form issue with no criteria (synth empty) gets
 * a need-criteria comment + NO spec PR + NO intake; the master switch off ⇒ no Jira
 * calls; the tracker switch off ⇒ start() builds no interval; a Jira outage on search
 * skips the cycle (watermark untouched).
 */
import { describe, it, expect, vi } from "vitest";
import {
  JiraIssuesPoller,
  type JiraIssuesPollerDeps,
  type TicketSynthesizer,
} from "../../../../server/services/consilium/trackers/jira-issues-poller.js";
import type { JiraHttpFn, JiraHttpResult } from "../../../../server/services/consilium/trackers/jira-exec.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

// ─── fakes ───────────────────────────────────────────────────────────────────

interface JiraOpts {
  issues?: unknown[];
  comments?: Array<{ body?: unknown }>;
  searchStatus?: number;
}

/** A fake Jira transport for the search + comment (idempotency read + post) chain. */
function fakeJira(opts: JiraOpts): { http: JiraHttpFn; calls: Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const http: JiraHttpFn = vi.fn(async (req): Promise<JiraHttpResult> => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    const json = (obj: unknown, status = 200): JiraHttpResult => ({ status, body: JSON.stringify(obj) });
    if (req.url.includes("/rest/api/3/search")) {
      if (opts.searchStatus && opts.searchStatus >= 400) return { status: opts.searchStatus, body: "err" };
      return json({ issues: opts.issues ?? [] });
    }
    if (req.url.includes("/comment") && req.method === "GET") return json({ comments: opts.comments ?? [] });
    if (req.url.includes("/comment") && req.method === "POST") return { status: 201, body: "{}" };
    return json({});
  });
  return { http, calls };
}

/** A fake `gh` that serves the writeSpecPr chain (no issue list — Jira does the watch). */
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

function jiraTrigger(config?: Partial<TrackerEventTriggerConfig>): TriggerRow {
  const full: TrackerEventTriggerConfig = {
    tracker: "jira",
    baseUrl: "https://acme.atlassian.net",
    project: "ACME",
    repo: "acme/widget",
    targetRepoPath: "/repo/widget",
    filter: { label: "agent" },
    specStatus: "ready",
    ...config,
  };
  return {
    id: "trk-jira-1",
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
  jira: JiraHttpFn;
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
  const deps: JiraIssuesPollerDeps = {
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
    jiraHttp: opts.jira,
    jiraAuth: { email: "a@b.co", token: "secret" },
    gitRemoteUrl: async () => "https://github.com/acme/widget.git",
    log: (m) => opts.logs?.push(m),
    now: () => 0,
  };
  return { poller: new JiraIssuesPoller(deps), updates };
}

const SHAPED_ISSUE = {
  key: "ACME-1",
  fields: {
    summary: "Add rate limiting",
    description: "## Problem\nNo limit.\n\n## Acceptance Criteria\n- returns 429 over 100 rpm\n- resets after window",
    labels: ["agent"],
    updated: "2026-01-02T10:00:00.000+0000",
  },
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

const jiraPosts = (calls: Array<{ method: string; url: string }>, needle: string) =>
  calls.filter((c) => c.method === "POST" && c.url.includes(needle)).length;

// ─── tests ───────────────────────────────────────────────────────────────────

describe("JiraIssuesPoller.pollAll", () => {
  it("JQL-matched issue → spec PR (source.kind=jira,ref=KEY) + ONE Jira pickup comment + intake", async () => {
    const { http, calls } = fakeJira({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: jiraTrigger(), jira: http, gh: run });
    await poller.pollAll();

    // Spec PR contents PUT to the deterministic jira docs/specs path.
    const put = argv.find(putContents);
    expect(put).toBeTruthy();
    expect(put!.some((x) => x.includes("contents/docs/specs/jira-ACME-1-add-rate-limiting.md"))).toBe(true);

    // The committed spec frontmatter carries JIRA provenance.
    const spec = decodePutContent(argv);
    expect(spec).toContain("kind: jira");
    expect(spec).toContain('ref: "ACME-1"');

    expect(count(argv, isPrCreate)).toBe(1);
    expect(jiraPosts(calls, "/comment")).toBe(1); // exactly one pickup comment

    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["ACME-1"]?.specPrUrl).toBe("https://github.com/acme/widget/pull/7");
  });

  it("re-poll the same issue → NO 2nd PR, NO 2nd Jira comment (watermark dedup)", async () => {
    const { http, calls } = fakeJira({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: jiraTrigger(), jira: http, gh: run });
    await poller.pollAll();
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(1);
    expect(jiraPosts(calls, "/comment")).toBe(1);
  });

  it("unlabelled issue → skipped (no spec PR, defence-in-depth)", async () => {
    const unlabelled = { ...SHAPED_ISSUE, key: "ACME-2", fields: { ...SHAPED_ISSUE.fields, labels: ["other"] } };
    const { http } = fakeJira({ issues: [unlabelled] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: jiraTrigger(), jira: http, gh: run });
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(0);
  });

  it("free-form issue + synthesiser empty → need-criteria comment, NO spec PR, NO intake", async () => {
    const freeForm = {
      key: "ACME-3",
      fields: { summary: "vague", description: "please make it better", labels: ["agent"] },
    };
    const synthesizer: TicketSynthesizer = { synthesize: async () => ({ criteria: [] }) };
    const { http, calls } = fakeJira({ issues: [freeForm] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: jiraTrigger(), jira: http, gh: run, synthesizer });
    await poller.pollAll();

    expect(jiraPosts(calls, "/comment")).toBe(1); // the ask-for-criteria comment
    expect(count(argv, isPrCreate)).toBe(0);
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["ACME-3"]).toBeUndefined();
  });

  it("no filter.label configured → skipped (no Jira search at all)", async () => {
    const { http, calls } = fakeJira({ issues: [SHAPED_ISSUE] });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: jiraTrigger({ filter: {} }), jira: http, gh: run });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("master switch off → no Jira calls at all", async () => {
    const { http, calls } = fakeJira({ issues: [SHAPED_ISSUE] });
    const { run } = fakeGh();
    const { poller } = harness({ trigger: jiraTrigger(), jira: http, gh: run, masterOn: false });
    await poller.pollAll();
    expect(calls.length).toBe(0);
  });

  it("Jira outage on search → skip cycle, watermark untouched, no crash", async () => {
    const { http } = fakeJira({ searchStatus: 500 });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: jiraTrigger(), jira: http, gh: run });
    await expect(poller.pollAll()).resolves.toBeUndefined();
    expect(updates.length).toBe(0);
  });

  it("targetRepoPath NOT in the allowlist → skipped fail-closed (no Jira, no gh)", async () => {
    const { http, calls } = fakeJira({ issues: [SHAPED_ISSUE] });
    const { run, argv } = fakeGh();
    const { poller } = harness({
      trigger: jiraTrigger(),
      jira: http,
      gh: run,
      allowedRepoPaths: () => ["/some/other/repo"],
    });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(argv.length).toBe(0);
  });
});

describe("JiraIssuesPoller.start gating", () => {
  it("tracker disabled → start() builds no interval", () => {
    vi.useFakeTimers();
    try {
      const { http } = fakeJira({ issues: [SHAPED_ISSUE] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: jiraTrigger(), jira: http, gh: run, trackerOn: false, logs });
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
      const { http } = fakeJira({ issues: [] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: jiraTrigger(), jira: http, gh: run, trackerOn: true, logs });
      poller.start();
      expect(logs.some((l) => l.includes("jira tracker poller started"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
