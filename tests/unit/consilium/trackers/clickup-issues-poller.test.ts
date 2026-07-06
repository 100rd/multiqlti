/**
 * clickup-issues-poller.test.ts — TRACK-5 poller with a FAKE ClickUp HTTP transport + FAKE
 * `gh`. Mirrors jira-issues-poller.test: a tagged task → the SHARED synth → a spec PR
 * (docs/specs/clickup-<id>-… whose frontmatter carries source.kind=clickup,ref=<id>) +
 * exactly ONE ClickUp pickup comment + a watermark intake; re-poll dedup; an untagged task
 * skipped; a free-form task with no criteria → need-criteria comment + NO PR + NO intake;
 * no filter.label / no clickupListId ⇒ skipped; master switch off ⇒ no calls; a list outage
 * skips the cycle (watermark untouched); a non-allowlisted targetRepoPath skips.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ClickUpIssuesPoller,
  type ClickUpIssuesPollerDeps,
} from "../../../../server/services/consilium/trackers/clickup-issues-poller.js";
import type { TicketSynthesizer } from "../../../../server/services/consilium/trackers/jira-issues-poller.js";
import type { ClickUpHttpFn, ClickUpHttpResult } from "../../../../server/services/consilium/trackers/clickup-exec.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

interface ClickUpOpts {
  tasks?: unknown[];
  comments?: Array<{ comment_text?: string }>;
  listStatus?: number;
}

function fakeClickUp(opts: ClickUpOpts): { http: ClickUpHttpFn; calls: Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const http: ClickUpHttpFn = vi.fn(async (req): Promise<ClickUpHttpResult> => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    const json = (obj: unknown, status = 200): ClickUpHttpResult => ({ status, body: JSON.stringify(obj) });
    if (req.url.includes("/comment") && req.method === "GET") return json({ comments: opts.comments ?? [] });
    if (req.url.includes("/comment") && req.method === "POST") return { status: 200, body: "{}" };
    if (req.url.includes("/task/") && req.method === "PUT") return { status: 200, body: "{}" };
    if (req.url.includes("/task") && req.method === "GET") {
      if (opts.listStatus && opts.listStatus >= 400) return { status: opts.listStatus, body: "err" };
      return json({ tasks: opts.tasks ?? [] });
    }
    return json({});
  });
  return { http, calls };
}

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

function clickupTrigger(config?: Partial<TrackerEventTriggerConfig>): TriggerRow {
  const full: TrackerEventTriggerConfig = {
    tracker: "clickup",
    clickupListId: "9001",
    repo: "acme/widget",
    targetRepoPath: "/repo/widget",
    filter: { label: "agent" },
    specStatus: "ready",
    ...config,
  };
  return {
    id: "trk-clickup-1",
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
    ({ features: { triggers: { enabled: masterOn, tracker: { enabled: trackerOn, pollIntervalSec } } } }) as unknown as AppConfig;
}

interface HarnessOpts {
  trigger: TriggerRow;
  clickup: ClickUpHttpFn;
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
  const deps: ClickUpIssuesPollerDeps = {
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
    clickupHttp: opts.clickup,
    clickupAuth: { token: "pk_secret" },
    gitRemoteUrl: async () => "https://github.com/acme/widget.git",
    log: (m) => opts.logs?.push(m),
    now: () => 0,
  };
  return { poller: new ClickUpIssuesPoller(deps), updates };
}

const SHAPED_TASK = {
  id: "abc123",
  name: "Add rate limiting",
  text_content: "## Problem\nNo limit.\n\n## Acceptance Criteria\n- returns 429 over 100 rpm\n- resets after window",
  tags: [{ name: "agent" }],
  date_updated: "1767225600000",
  url: "https://app.clickup.com/t/abc123",
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
const clickupCommentPosts = (calls: Array<{ method: string; url: string }>) =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/comment")).length;

describe("ClickUpIssuesPoller.pollAll", () => {
  it("tagged task → spec PR (source.kind=clickup,ref=id) + ONE ClickUp pickup comment + intake", async () => {
    const { http, calls } = fakeClickUp({ tasks: [SHAPED_TASK] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: clickupTrigger(), clickup: http, gh: run });
    await poller.pollAll();

    const put = argv.find(putContents);
    expect(put!.some((x) => x.includes("contents/docs/specs/clickup-abc123-add-rate-limiting.md"))).toBe(true);
    const spec = decodePutContent(argv);
    expect(spec).toContain("kind: clickup");
    expect(spec).toContain('ref: "abc123"');

    expect(count(argv, isPrCreate)).toBe(1);
    expect(clickupCommentPosts(calls)).toBe(1);

    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["abc123"]?.specPrUrl).toBe("https://github.com/acme/widget/pull/7");
  });

  it("re-poll the same task → NO 2nd PR, NO 2nd comment (watermark dedup)", async () => {
    const { http, calls } = fakeClickUp({ tasks: [SHAPED_TASK] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: clickupTrigger(), clickup: http, gh: run });
    await poller.pollAll();
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(1);
    expect(clickupCommentPosts(calls)).toBe(1);
  });

  it("untagged task → skipped (defence-in-depth)", async () => {
    const untagged = { ...SHAPED_TASK, id: "def456", tags: [{ name: "other" }] };
    const { http } = fakeClickUp({ tasks: [untagged] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: clickupTrigger(), clickup: http, gh: run });
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(0);
  });

  it("free-form task + synthesiser empty → need-criteria comment, NO PR, NO intake", async () => {
    const freeForm = { id: "ghi789", name: "vague", text_content: "please make it better", tags: [{ name: "agent" }] };
    const synthesizer: TicketSynthesizer = { synthesize: async () => ({ criteria: [] }) };
    const { http, calls } = fakeClickUp({ tasks: [freeForm] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: clickupTrigger(), clickup: http, gh: run, synthesizer });
    await poller.pollAll();
    expect(clickupCommentPosts(calls)).toBe(1);
    expect(count(argv, isPrCreate)).toBe(0);
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["ghi789"]).toBeUndefined();
  });

  it("no filter.label → skipped (no ClickUp calls)", async () => {
    const { http, calls } = fakeClickUp({ tasks: [SHAPED_TASK] });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: clickupTrigger({ filter: {} }), clickup: http, gh: run });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("no clickupListId → skipped (no ClickUp calls)", async () => {
    const { http, calls } = fakeClickUp({ tasks: [SHAPED_TASK] });
    const { run } = fakeGh();
    const { poller } = harness({ trigger: clickupTrigger({ clickupListId: "" }), clickup: http, gh: run });
    await poller.pollAll();
    expect(calls.length).toBe(0);
  });

  it("master switch off → no ClickUp calls at all", async () => {
    const { http, calls } = fakeClickUp({ tasks: [SHAPED_TASK] });
    const { run } = fakeGh();
    const { poller } = harness({ trigger: clickupTrigger(), clickup: http, gh: run, masterOn: false });
    await poller.pollAll();
    expect(calls.length).toBe(0);
  });

  it("ClickUp list outage → skip cycle, watermark untouched, no crash", async () => {
    const { http } = fakeClickUp({ listStatus: 500 });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: clickupTrigger(), clickup: http, gh: run });
    await expect(poller.pollAll()).resolves.toBeUndefined();
    expect(updates.length).toBe(0);
  });

  it("targetRepoPath NOT in the allowlist → skipped fail-closed (no ClickUp, no gh)", async () => {
    const { http, calls } = fakeClickUp({ tasks: [SHAPED_TASK] });
    const { run, argv } = fakeGh();
    const { poller } = harness({
      trigger: clickupTrigger(),
      clickup: http,
      gh: run,
      allowedRepoPaths: () => ["/some/other/repo"],
    });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(argv.length).toBe(0);
  });
});

describe("ClickUpIssuesPoller.start gating", () => {
  it("tracker disabled → start() builds no interval", () => {
    vi.useFakeTimers();
    try {
      const { http } = fakeClickUp({ tasks: [SHAPED_TASK] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: clickupTrigger(), clickup: http, gh: run, trackerOn: false, logs });
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
      const { http } = fakeClickUp({ tasks: [] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: clickupTrigger(), clickup: http, gh: run, trackerOn: true, logs });
      poller.start();
      expect(logs.some((l) => l.includes("clickup tracker poller started"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
