/**
 * github-command-poller.test.ts — TRACK-6 (task-tracker-triggers.md §8): the /spec,
 * /approve, /stop comment commands with commenter-role auth, idempotency, and the
 * kill-switches. Fakes the `gh` seam + the loop controller.
 */
import { describe, it, expect, vi } from "vitest";
import {
  GithubCommandPoller,
  type GithubCommandPollerDeps,
} from "../../../../server/services/consilium/trackers/github-command-poller.js";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import type { TriggerRow, ConsiliumLoopRow } from "../../../../shared/schema.js";
import type { AppConfig, TrackerEventTriggerConfig } from "../../../../shared/types.js";

interface GhOpts {
  comments?: Array<{ id: number; body: string; created_at?: string; user?: { login?: string }; issue_url?: string }>;
  assignees?: Array<{ login?: string }>;
  permission?: string;
}

/** A fake `gh` dispatching on argv, recording every call. */
function fakeGh(opts: GhOpts): { run: ExecFileFn; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    const json = (o: unknown) => ({ stdout: JSON.stringify(o), stderr: "" });
    // Repo issue-comments list.
    if (args[0] === "api" && args.includes("repos/acme/widget/issues/comments")) {
      return json(opts.comments ?? []);
    }
    // Collaborator permission (auth maintainer check).
    if (args[0] === "api" && String(args[1]).includes("/collaborators/")) {
      if (opts.permission === undefined) throw new Error("404");
      return json({ permission: opts.permission });
    }
    // issue view — assignees (auth) | crystallise read | pickup comments.
    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("assignees")) return json({ assignees: opts.assignees ?? [] });
      if (args.some((a) => a.includes("number,title,body"))) {
        return json({ number: 42, title: "Add caching", url: "https://github.com/acme/widget/issues/42", labels: [], body: "## Acceptance Criteria\n- [ ] cache hit ratio > 0.9" });
      }
      return json({ comments: [] });
    }
    if (args[0] === "issue" && args[1] === "comment") return { stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") return json([]);
    if (args[0] === "pr" && args[1] === "ready") return { stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "create") return { stdout: "https://github.com/acme/widget/pull/9\n", stderr: "" };
    if (args[0] === "repo" && args[1] === "view") return json({ defaultBranchRef: { name: "main" } });
    if (args[0] === "api") return json({ object: { sha: "basesha" } });
    return { stdout: "", stderr: "" };
  });
  return { run, argv };
}

function trigger(): TriggerRow {
  const config: TrackerEventTriggerConfig = {
    tracker: "github", repo: "acme/widget", targetRepoPath: "/repo/widget",
    filter: { label: "agent" }, specStatus: "ready",
  };
  return {
    id: "trk-1", projectId: "proj-1", pipelineId: null, type: "tracker_event",
    config: JSON.parse(JSON.stringify(config)) as TrackerEventTriggerConfig,
    secretEncrypted: null, enabled: true, lastTriggeredAt: null, suppressedCount: 0,
    createdAt: new Date(0), updatedAt: new Date(0),
  } as unknown as TriggerRow;
}

function activeLoop(): ConsiliumLoopRow {
  return {
    id: "loop-1", state: "reviewing", repoPath: "/repo/widget",
    triggerProvenance: { firedAt: "2020", spec: { specPath: "docs/specs/x.md", status: "ready", source: { kind: "github", ref: "42", url: "https://github.com/acme/widget/issues/42" } } },
  } as unknown as ConsiliumLoopRow;
}

function cfg(masterOn = true, commandsOn = true, trackerOn = true): () => AppConfig {
  return () => ({
    features: { triggers: { enabled: masterOn, tracker: { enabled: trackerOn, pollIntervalSec: 300, commands: { enabled: commandsOn } } } },
  }) as unknown as AppConfig;
}

interface HarnessOpts {
  gh: ExecFileFn;
  masterOn?: boolean;
  commandsOn?: boolean;
  loops?: ConsiliumLoopRow[];
  cancelLoop?: GithubCommandPollerDeps["cancelLoop"];
}

function harness(opts: HarnessOpts) {
  let stored = trigger();
  const updates: Array<Partial<TriggerRow>> = [];
  const cancelLoop = opts.cancelLoop ?? vi.fn(async () => activeLoop());
  const deps: GithubCommandPollerDeps = {
    getEnabledTriggersByType: async () => [stored],
    runInProject: async (_pid, fn) => fn(),
    getTrigger: async () => stored,
    updateTrigger: async (_id, u) => {
      updates.push(u);
      if (u.config) stored = { ...stored, config: u.config } as TriggerRow;
      return stored;
    },
    config: cfg(opts.masterOn ?? true, opts.commandsOn ?? true),
    allowedRepoPaths: () => ["/repo/widget"],
    getLoops: async () => opts.loops ?? [],
    cancelLoop,
    runGh: opts.gh,
    gitRemoteUrl: async () => "https://github.com/acme/widget.git",
    log: () => {},
    now: () => 1_000_000,
  };
  return { poller: new GithubCommandPoller(deps), updates, cancelLoop };
}

const comment = (body: string, over: Partial<{ id: number; user: { login?: string } }> = {}) => ({
  id: over.id ?? 100,
  body,
  created_at: "2021-01-01T00:00:00Z",
  user: over.user ?? { login: "alice" },
  issue_url: "https://api.github.com/repos/acme/widget/issues/42",
});

const isPrCreate = (a: string[]) => a[0] === "pr" && a[1] === "create";
const isPrReady = (a: string[]) => a[0] === "pr" && a[1] === "ready";
const count = (argv: string[][], p: (a: string[]) => boolean) => argv.filter(p).length;

describe("GithubCommandPoller", () => {
  it("/spec from an AUTHORIZED commenter (assignee) forces intake (opens a spec PR)", async () => {
    const { run, argv } = fakeGh({ comments: [comment("/spec")], assignees: [{ login: "alice" }] });
    const { poller } = harness({ gh: run });
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(1);
  });

  it("/spec from an UNAUTHORIZED commenter is IGNORED (no intake)", async () => {
    const { run, argv } = fakeGh({ comments: [comment("/spec", { user: { login: "mallory" } })], assignees: [{ login: "alice" }] });
    const { poller } = harness({ gh: run });
    await poller.pollAll();
    expect(count(argv, isPrCreate)).toBe(0);
  });

  it("/approve (authorized) marks the spec PR ready-for-review", async () => {
    const { run, argv } = fakeGh({ comments: [comment("/approve")], assignees: [{ login: "alice" }] });
    const { poller } = harness({ gh: run });
    await poller.pollAll();
    const ready = argv.find(isPrReady);
    expect(ready).toBeTruthy();
    expect(ready).toEqual(["pr", "ready", "spec/gh-issue-42", "--repo", "acme/widget"]);
  });

  it("/stop (authorized) cancels the ticket's active loop", async () => {
    const { run } = fakeGh({ comments: [comment("/stop")], assignees: [{ login: "alice" }] });
    const cancelLoop = vi.fn(async () => activeLoop());
    const { poller } = harness({ gh: run, loops: [activeLoop()], cancelLoop });
    await poller.pollAll();
    expect(cancelLoop).toHaveBeenCalledWith("loop-1", expect.objectContaining({ actor: "tracker:/stop" }));
  });

  it("/stop (authorized) is a no-op when no active loop traces to the ticket", async () => {
    const { run } = fakeGh({ comments: [comment("/stop")], assignees: [{ login: "alice" }] });
    const cancelLoop = vi.fn(async () => null);
    const { poller } = harness({ gh: run, loops: [], cancelLoop });
    await poller.pollAll();
    expect(cancelLoop).not.toHaveBeenCalled();
  });

  it("is IDEMPOTENT — a re-poll does not re-act the same command", async () => {
    const { run, argv } = fakeGh({ comments: [comment("/spec")], assignees: [{ login: "alice" }] });
    const { poller } = harness({ gh: run });
    await poller.pollAll();
    await poller.pollAll(); // watermark now carries the processed comment id.
    expect(count(argv, isPrCreate)).toBe(1);
  });

  it("records the command watermark (processed id + lastCommentAt)", async () => {
    const { run } = fakeGh({ comments: [comment("/approve")], assignees: [{ login: "alice" }] });
    const { poller, updates } = harness({ gh: run });
    await poller.pollAll();
    const last = updates[updates.length - 1].config as TrackerEventTriggerConfig;
    expect(last.commandState?.processed?.["100"]).toBeTruthy();
    expect(last.commandState?.lastCommentAt).toBe("2021-01-01T00:00:00.000Z");
  });

  it("commands sub-switch OFF → no gh at all (kill-switch holds)", async () => {
    const { run, argv } = fakeGh({ comments: [comment("/spec")], assignees: [{ login: "alice" }] });
    const { poller } = harness({ gh: run, commandsOn: false });
    await poller.pollAll();
    expect(argv.length).toBe(0);
  });

  it("master switch OFF → no gh at all", async () => {
    const { run, argv } = fakeGh({ comments: [comment("/spec")], assignees: [{ login: "alice" }] });
    const { poller } = harness({ gh: run, masterOn: false });
    await poller.pollAll();
    expect(argv.length).toBe(0);
  });

  it("a non-command comment is skipped (no auth check, no action)", async () => {
    const { run, argv } = fakeGh({ comments: [comment("just a normal note")], assignees: [{ login: "alice" }] });
    const { poller } = harness({ gh: run });
    await poller.pollAll();
    // Only the comments-list read happened; no issue view (auth) / pr / etc.
    expect(argv.every((a) => a[0] === "api" && a.includes("repos/acme/widget/issues/comments"))).toBe(true);
  });
});
