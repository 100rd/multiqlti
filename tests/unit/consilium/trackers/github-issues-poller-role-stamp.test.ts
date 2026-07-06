/**
 * github-issues-poller-role-stamp.test.ts — TRACK-6 (standing-role.md §5): a tracker
 * trigger BOUND to a Standing Role's concern STAMPS the role's name + skills into the
 * crystallised spec, so on merge SPEC-1 fires the ROLE's loop. A disabled role (or the
 * absence of a role binding) yields an UNSTAMPED spec — byte-identical to TRACK-1.
 */
import { describe, it, expect, vi } from "vitest";
import {
  GithubIssuesPoller,
  type GithubIssuesPollerDeps,
} from "../../../../server/services/consilium/trackers/github-issues-poller.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow, StandingRoleRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

function fakeGh(issues: unknown[], prUrl = "https://github.com/acme/widget/pull/7"): { run: ExecFileFn; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    const json = (o: unknown) => ({ stdout: JSON.stringify(o), stderr: "" });
    if (args[0] === "issue" && args[1] === "list") return json(issues);
    if (args[0] === "issue" && args[1] === "view") return json({ comments: [] });
    if (args[0] === "issue" && args[1] === "comment") return { stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") return json([]);
    if (args[0] === "repo" && args[1] === "view") return json({ defaultBranchRef: { name: "main" } });
    if (args[0] === "api") {
      if (args.indexOf("--method") === -1 && args.indexOf("PUT") === -1) return json({ object: { sha: "basesha" } });
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "create") return { stdout: `${prUrl}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  });
  return { run, argv };
}

const ISSUE = {
  number: 5,
  title: "Add pagination",
  url: "https://github.com/acme/widget/issues/5",
  labels: [{ name: "agent" }],
  body: "## Problem\nNo paging.\n\n## Acceptance Criteria\n- [ ] returns next-page cursor",
};

function trackerTrigger(roleConcern?: { roleId: string; concernId: string }): TriggerRow {
  const config: TrackerEventTriggerConfig = {
    tracker: "github",
    repo: "acme/widget",
    targetRepoPath: "/repo/widget",
    filter: { label: "agent" },
    specStatus: "ready",
    ...(roleConcern ? { roleConcern } : {}),
  };
  return {
    id: "trk-1", projectId: "proj-1", pipelineId: null, type: "tracker_event",
    config: JSON.parse(JSON.stringify(config)) as TrackerEventTriggerConfig,
    secretEncrypted: null, enabled: true, lastTriggeredAt: null, suppressedCount: 0,
    createdAt: new Date(0), updatedAt: new Date(0),
  } as unknown as TriggerRow;
}

function roleRow(over: Partial<StandingRoleRow> = {}): StandingRoleRow {
  return {
    id: "role-1", name: "backend-dev", persona: "senior backend engineer",
    skills: ["python-dev", "test-authoring"], loopTemplate: { preset: "sdlc-cross-review" },
    concerns: [{
      id: "c-1", repoPath: "/repo/widget", focus: "implement the ticket",
      trigger: { type: "tracker_event", filter: { tracker: "github", repo: "acme/widget", label: "agent" } },
    }],
    policy: null, enabled: true, createdBy: "u-1", createdAt: new Date(0), updatedAt: new Date(0),
    ...over,
  } as unknown as StandingRoleRow;
}

function cfg(): () => AppConfig {
  return () => ({ features: { triggers: { enabled: true, tracker: { enabled: true, pollIntervalSec: 300 } } } }) as unknown as AppConfig;
}

function harness(trigger: TriggerRow, role: StandingRoleRow | undefined, gh: ExecFileFn) {
  const deps: GithubIssuesPollerDeps = {
    getEnabledTriggersByType: async () => [trigger],
    runInProject: async (_pid, fn) => fn(),
    getTrigger: async () => trigger,
    updateTrigger: async () => trigger,
    config: cfg(),
    allowedRepoPaths: () => ["/repo/widget"],
    getStandingRole: async (id) => (role && role.id === id ? role : undefined),
    runGh: gh,
    gitRemoteUrl: async () => "https://github.com/acme/widget.git",
    log: () => {},
    now: () => 0,
  };
  return new GithubIssuesPoller(deps);
}

function decodePutContent(argv: string[][]): string {
  const put = argv.find((a) => a[0] === "api" && a.includes("PUT") && a.some((x) => x.startsWith("repos/acme/widget/contents/")));
  const arg = put?.find((x) => x.startsWith("content="));
  return arg ? Buffer.from(arg.slice("content=".length), "base64").toString("utf8") : "";
}

describe("GithubIssuesPoller role stamping (TRACK-6)", () => {
  it("a role-bound tracker trigger stamps the role's name + skills into the spec", async () => {
    const { run, argv } = fakeGh([ISSUE]);
    const poller = harness(trackerTrigger({ roleId: "role-1", concernId: "c-1" }), roleRow(), run);
    await poller.pollAll();
    const spec = decodePutContent(argv);
    expect(spec).toContain('role: "backend-dev"');
    expect(spec).toContain("skills:");
    expect(spec).toContain('- "python-dev"');
    expect(spec).toContain('- "test-authoring"');
    // Still a valid TRACK-1 spec (github provenance intact).
    expect(spec).toContain("kind: github");
    expect(spec).toContain('ref: "5"');
  });

  it("a DISABLED role → UNSTAMPED spec (never a disabled role's work)", async () => {
    const { run, argv } = fakeGh([ISSUE]);
    const poller = harness(
      trackerTrigger({ roleId: "role-1", concernId: "c-1" }),
      roleRow({ enabled: false } as Partial<StandingRoleRow>),
      run,
    );
    await poller.pollAll();
    const spec = decodePutContent(argv);
    expect(spec).not.toContain("role:");
    expect(spec).not.toContain("skills:");
  });

  it("no role binding → UNSTAMPED spec (byte-identical TRACK-1)", async () => {
    const { run, argv } = fakeGh([ISSUE]);
    const poller = harness(trackerTrigger(), undefined, run);
    await poller.pollAll();
    const spec = decodePutContent(argv);
    expect(spec).not.toContain("role:");
    expect(spec).not.toContain("skills:");
  });
});
