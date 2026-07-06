/**
 * azure-issues-poller.test.ts — TRACK-5 poller with a FAKE Azure HTTP transport + FAKE
 * `gh`. Mirrors jira-issues-poller.test: a tagged work item → the SHARED synth → a spec PR
 * (docs/specs/azure-<id>-… whose frontmatter carries source.kind=azure,ref=<id>) + exactly
 * ONE Azure pickup comment + a watermark intake; re-poll dedup; an untagged item skipped;
 * a free-form item with no criteria → need-criteria comment + NO PR + NO intake; no
 * filter.label / no azureOrg ⇒ skipped (no Azure calls); master switch off ⇒ no calls; a
 * WIQL outage skips the cycle (watermark untouched); a non-allowlisted targetRepoPath skips.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AzureIssuesPoller,
  type AzureIssuesPollerDeps,
} from "../../../../server/services/consilium/trackers/azure-issues-poller.js";
import type { TicketSynthesizer } from "../../../../server/services/consilium/trackers/jira-issues-poller.js";
import type { AzureHttpFn, AzureHttpResult } from "../../../../server/services/consilium/trackers/azure-exec.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

interface AzureOpts {
  workItems?: Array<{ id?: number }>;
  value?: unknown[];
  comments?: Array<{ text?: string }>;
  wiqlStatus?: number;
}

function fakeAzure(opts: AzureOpts): { http: AzureHttpFn; calls: Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const http: AzureHttpFn = vi.fn(async (req): Promise<AzureHttpResult> => {
    calls.push({ method: req.method, url: req.url, body: req.body });
    const json = (obj: unknown, status = 200): AzureHttpResult => ({ status, body: JSON.stringify(obj) });
    if (req.url.includes("/wiql")) {
      if (opts.wiqlStatus && opts.wiqlStatus >= 400) return { status: opts.wiqlStatus, body: "err" };
      return json({ workItems: opts.workItems ?? [] });
    }
    if (req.url.includes("/workitems") && req.method === "GET") return json({ value: opts.value ?? [] });
    if (req.url.includes("/comments") && req.method === "GET") return json({ comments: opts.comments ?? [] });
    if (req.url.includes("/comments") && req.method === "POST") return { status: 200, body: "{}" };
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

function azureTrigger(config?: Partial<TrackerEventTriggerConfig>): TriggerRow {
  const full: TrackerEventTriggerConfig = {
    tracker: "azure",
    azureOrg: "acme",
    project: "Widget",
    repo: "acme/widget",
    targetRepoPath: "/repo/widget",
    filter: { label: "agent" },
    specStatus: "ready",
    ...config,
  };
  return {
    id: "trk-azure-1",
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
  azure: AzureHttpFn;
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
  const deps: AzureIssuesPollerDeps = {
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
    azureHttp: opts.azure,
    azureAuth: { pat: "secret-pat" },
    gitRemoteUrl: async () => "https://github.com/acme/widget.git",
    log: (m) => opts.logs?.push(m),
    now: () => 0,
  };
  return { poller: new AzureIssuesPoller(deps), updates };
}

const SHAPED_WORKITEM = {
  id: 42,
  fields: {
    "System.Title": "Add rate limiting",
    "System.Description": "<p>## Acceptance Criteria</p><ul><li>returns 429 over 100 rpm</li><li>resets after window</li></ul>",
    "System.Tags": "agent; backend",
    "System.ChangedDate": "2026-01-02T10:00:00Z",
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
const azurePosts = (calls: Array<{ method: string; url: string }>, needle: string) =>
  calls.filter((c) => c.method === "POST" && c.url.includes(needle)).length;

describe("AzureIssuesPoller.pollAll", () => {
  it("tagged work item → spec PR (source.kind=azure,ref=id) + ONE Azure pickup comment + intake", async () => {
    const { http, calls } = fakeAzure({ workItems: [{ id: 42 }], value: [SHAPED_WORKITEM] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: azureTrigger(), azure: http, gh: run });
    await poller.pollAll();

    const put = argv.find(putContents);
    expect(put!.some((x) => x.includes("contents/docs/specs/azure-42-add-rate-limiting.md"))).toBe(true);
    const spec = decodePutContent(argv);
    expect(spec).toContain("kind: azure");
    expect(spec).toContain('ref: "42"');

    expect(count(argv, isPrCreate)).toBe(1);
    expect(azurePosts(calls, "/comments")).toBe(1);

    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["42"]?.specPrUrl).toBe("https://github.com/acme/widget/pull/7");
  });

  it("re-poll the same item → NO 2nd PR, NO 2nd comment (watermark dedup)", async () => {
    const { http, calls } = fakeAzure({ workItems: [{ id: 42 }], value: [SHAPED_WORKITEM] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: azureTrigger(), azure: http, gh: run });
    await poller.pollAll();
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(1);
    expect(azurePosts(calls, "/comments")).toBe(1);
  });

  it("untagged item → skipped (defence-in-depth)", async () => {
    const untagged = { ...SHAPED_WORKITEM, id: 43, fields: { ...SHAPED_WORKITEM.fields, "System.Tags": "other" } };
    const { http } = fakeAzure({ workItems: [{ id: 43 }], value: [untagged] });
    const { run, argv } = fakeGh();
    const { poller } = harness({ trigger: azureTrigger(), azure: http, gh: run });
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(0);
  });

  it("free-form item + synthesiser empty → need-criteria comment, NO PR, NO intake", async () => {
    const freeForm = {
      id: 44,
      fields: { "System.Title": "vague", "System.Description": "<p>please make it better</p>", "System.Tags": "agent" },
    };
    const synthesizer: TicketSynthesizer = { synthesize: async () => ({ criteria: [] }) };
    const { http, calls } = fakeAzure({ workItems: [{ id: 44 }], value: [freeForm] });
    const { run, argv } = fakeGh();
    const { poller, updates } = harness({ trigger: azureTrigger(), azure: http, gh: run, synthesizer });
    await poller.pollAll();
    expect(azurePosts(calls, "/comments")).toBe(1);
    expect(count(argv, isPrCreate)).toBe(0);
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.pollState?.intake?.["44"]).toBeUndefined();
  });

  it("no filter.label → skipped (no Azure calls)", async () => {
    const { http, calls } = fakeAzure({ workItems: [{ id: 42 }], value: [SHAPED_WORKITEM] });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: azureTrigger({ filter: {} }), azure: http, gh: run });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  it("no azureOrg → skipped (no Azure calls)", async () => {
    const { http, calls } = fakeAzure({ workItems: [{ id: 42 }], value: [SHAPED_WORKITEM] });
    const { run } = fakeGh();
    const { poller } = harness({ trigger: azureTrigger({ azureOrg: "" }), azure: http, gh: run });
    await poller.pollAll();
    expect(calls.length).toBe(0);
  });

  it("master switch off → no Azure calls at all", async () => {
    const { http, calls } = fakeAzure({ workItems: [{ id: 42 }], value: [SHAPED_WORKITEM] });
    const { run } = fakeGh();
    const { poller } = harness({ trigger: azureTrigger(), azure: http, gh: run, masterOn: false });
    await poller.pollAll();
    expect(calls.length).toBe(0);
  });

  it("Azure WIQL outage → skip cycle, watermark untouched, no crash", async () => {
    const { http } = fakeAzure({ wiqlStatus: 500 });
    const { run } = fakeGh();
    const { poller, updates } = harness({ trigger: azureTrigger(), azure: http, gh: run });
    await expect(poller.pollAll()).resolves.toBeUndefined();
    expect(updates.length).toBe(0);
  });

  it("targetRepoPath NOT in the allowlist → skipped fail-closed (no Azure, no gh)", async () => {
    const { http, calls } = fakeAzure({ workItems: [{ id: 42 }], value: [SHAPED_WORKITEM] });
    const { run, argv } = fakeGh();
    const { poller } = harness({
      trigger: azureTrigger(),
      azure: http,
      gh: run,
      allowedRepoPaths: () => ["/some/other/repo"],
    });
    await poller.pollAll();
    expect(calls.length).toBe(0);
    expect(argv.length).toBe(0);
  });
});

describe("AzureIssuesPoller.start gating", () => {
  it("tracker disabled → start() builds no interval", () => {
    vi.useFakeTimers();
    try {
      const { http } = fakeAzure({ workItems: [{ id: 42 }], value: [SHAPED_WORKITEM] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: azureTrigger(), azure: http, gh: run, trackerOn: false, logs });
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
      const { http } = fakeAzure({ workItems: [] });
      const { run } = fakeGh();
      const logs: string[] = [];
      const { poller } = harness({ trigger: azureTrigger(), azure: http, gh: run, trackerOn: true, logs });
      poller.start();
      expect(logs.some((l) => l.includes("azure tracker poller started"))).toBe(true);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
