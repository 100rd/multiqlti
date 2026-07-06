/**
 * linear-issues-poller.test.ts — TRACK-5 poller with a FAKE Linear GraphQL transport +
 * FAKE `gh`. Mirrors jira-issues-poller.test: a labelled issue → the SHARED synth → a spec
 * PR (docs/specs/linear-<ID>-… whose frontmatter carries source.kind=linear,ref=<ID>) +
 * exactly ONE Linear pickup comment + a watermark intake; a re-poll dedups; an unlabelled
 * issue is skipped; a free-form issue with no criteria gets a need-criteria comment + NO PR
 * + NO intake; the master switch off ⇒ no Linear calls; the tracker switch off ⇒ no
 * interval; a Linear outage on the poll skips the cycle (watermark untouched); a
 * non-allowlisted targetRepoPath is skipped fail-closed.
 */
import { describe, it, expect, vi } from "vitest";
import {
  LinearIssuesPoller,
  type LinearIssuesPollerDeps,
} from "../../../../server/services/consilium/trackers/linear-issues-poller.js";
import type { TicketSynthesizer } from "../../../../server/services/consilium/trackers/jira-issues-poller.js";
import type { LinearHttpFn, LinearHttpResult } from "../../../../server/services/consilium/trackers/linear-exec.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

interface LinearOpts {
  nodes?: unknown[];
  pollErrors?: boolean;
  commentsNodes?: Array<{ body?: string }>;
}

function fakeLinear(opts: LinearOpts): { http: LinearHttpFn; queries: string[] } {
  const queries: string[] = [];
  const http: LinearHttpFn = vi.fn(async (req): Promise<LinearHttpResult> => {
    const { query } = JSON.parse(req.body ?? "{}") as { query: string };
    queries.push(query);
    const json = (obj: unknown, status = 200): LinearHttpResult => ({ status, body: JSON.stringify(obj) });
    if (query.includes("issues(")) {
      if (opts.pollErrors) return json({ errors: [{ message: "boom" }] });
      return json({ data: { issues: { nodes: opts.nodes ?? [] } } });
    }
    if (query.includes("comments(")) {
      return json({
        data: { issue: { id: "uuid-1", comments: { nodes: opts.commentsNodes ?? [] }, team: { states: { nodes: [] } } } },
      });
    }
    if (query.includes("commentCreate")) return json({ data: { commentCreate: { success: true } } });
    if (query.includes("issueUpdate")) return json({ data: { issueUpdate: { success: true } } });
    return json({ data: {} });
  });
  return { http, queries };
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

function linearTrigger(config?: Partial<TrackerEventTriggerConfig>): TriggerRow {
  const full: TrackerEventTriggerConfig = {
    tracker: "linear",
    repo: "acme/widget",
    targetRepoPath: "/repo/widget",
    filter: { label: "agent" },
    specStatus: "ready",
    ...config,
  };
  return {
    id: "trk-linear-1",
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
  linear: LinearHttpFn;
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
  const deps: LinearIssuesPollerDeps = {
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
    linearHttp: opts.linear,
    linearAuth: { token: "lin_api_secret" },
    gitRemoteUrl: async () => "https://github.com/acme/widget.git",
    log: (m) => opts.logs?.push(m),
    now: () => 0,
  };
  return { poller: new LinearIssuesPoller(deps), updates };
}

const SHAPED_NODE = {
  id: "uuid-1",
  identifier: "LIN-1",
  title: "Add rate limiting",
  description: "## Problem\nNo limit.\n\n## Acceptance Criteria\n- returns 429 over 100 rpm\n- resets after window",
  labels: { nodes: [{ name: "agent" }] },
  updatedAt: "2026-01-02T10:00:00.000Z",
  url: "https://linear.app/acme/issue/LIN-1",
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
const commentCreates = (queries: string[]) => queries.filter((q) => q.includes("commentCreate")).length;

describe("LinearIssuesPoller.pollAll", () => {
  it("labelled issue → spec PR (source.kind=linear,ref=ID) + ONE Linear pickup comment + intake", async () => {
    const { http, queries } = fakeLinear({ nodes: [SHAPED_NODE] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: linearTrigger(), linear: http, gh: run });
    await poller.pollAll();

    const put = argv.find(putContents);
    expect(put!.some((x) => x.includes("contents/docs/specs/linear-LIN-1-add-rate-limiting.md"))).toBe(true);
    const spec = decodePutContent(argv);
    expect(spec).toContain("kind: linear");
    expect(spec).toContain('ref: "LIN-1"');

    expect(count(argv, isPrCreate)).toBe(1);
    expect(commentCreates(queries)).toBe(1);

    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["LIN-1"]?.specPrUrl).toBe("https://github.com/acme/widget/pull/7");
  });

  it("re-poll the same issue → NO 2nd PR, NO 2nd comment (watermark dedup)", async () => {
    const { http, queries } = fakeLinear({ nodes: [SHAPED_NODE] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: linearTrigger(), linear: http, gh: run });
    await poller.pollAll();
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(1);
    expect(commentCreates(queries)).toBe(1);
  });

  it("unlabelled issue → skipped (defence-in-depth)", async () => {
    const unlabelled = { ...SHAPED_NODE, identifier: "LIN-2", labels: { nodes: [{ name: "other" }] } };
    const { http } = fakeLinear({ nodes: [unlabelled] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: linearTrigger(), linear: http, gh: run });
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(0);
  });

  it("free-form issue + synthesiser empty → need-criteria comment, NO PR, NO intake", async () => {
    const freeForm = {
      id: "uuid-3",
      identifier: "LIN-3",
      title: "vague",
      description: "please make it better",
      labels: { nodes: [{ name: "agent" }] },
    };
    const synthesizer: TicketSynthesizer = { synthesize: async () => ({ criteria: [] }) };
    const { http, queries } = fakeLinear({ nodes: [freeForm] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: linearTrigger(), linear: http, gh: run, synthesizer });
    await poller.pollAll();
    expect(commentCreates(queries)).toBe(1);
    expect(count(argv, isPrCreate)).toBe(0);
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["LIN-3"]).toBeUndefined();
  });

  it("no filter.label → skipped (no Linear calls)", async () => {
    const { http, queries } = fakeLinear({ nodes: [SHAPED_NODE] });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: linearTrigger({ filter: {} }), linear: http, gh: run });
    await poller.pollAll();
    expect(queries.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("master switch off → no Linear calls at all", async () => {
    const { http, queries } = fakeLinear({ nodes: [SHAPED_NODE] });
    const { run } = fakeGh();
    const { poller } = harness({ trigger: linearTrigger(), linear: http, gh: run, masterOn: false });
    await poller.pollAll();
    expect(queries.length).toBe(0);
  });

  it("Linear outage on poll → skip cycle, watermark untouched, no crash", async () => {
    const { http } = fakeLinear({ pollErrors: true });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: linearTrigger(), linear: http, gh: run });
    await expect(poller.pollAll()).resolves.toBeUndefined();
    expect(updates.length).toBe(0);
  });

  it("targetRepoPath NOT in the allowlist → skipped fail-closed (no Linear, no gh)", async () => {
    const { http, queries } = fakeLinear({ nodes: [SHAPED_NODE] });
    const { run, argv } = fakeGh();
    const { poller } = harness({
      trigger: linearTrigger(),
      linear: http,
      gh: run,
      allowedRepoPaths: () => ["/some/other/repo"],
    });
    await poller.pollAll();
    expect(queries.length).toBe(0);
    expect(argv.length).toBe(0);
  });
});

describe("LinearIssuesPoller.start gating", () => {
  it("tracker disabled → start() builds no interval", () => {
    vi.useFakeTimers();
    try {
      const { http } = fakeLinear({ nodes: [SHAPED_NODE] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: linearTrigger(), linear: http, gh: run, trackerOn: false, logs });
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
      const { http } = fakeLinear({ nodes: [] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: linearTrigger(), linear: http, gh: run, trackerOn: true, logs });
      poller.start();
      expect(logs.some((l) => l.includes("linear tracker poller started"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
