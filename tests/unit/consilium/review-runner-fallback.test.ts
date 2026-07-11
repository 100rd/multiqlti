/**
 * review-runner-fallback.test.ts — Part B (throttled v2, per-seat model fallback)
 * unit coverage for `runReviewTasks`. Drives the DAG with a fake gateway keyed by
 * (task name, model slug) so a seat's ORIGINAL model can rate-limit while its
 * fallback candidate (a DIFFERENT slug, same task) succeeds. Asserts:
 *   (a) a non-judge seat rate-limits on its original model → auto-rotates to a
 *       different-provider candidate, verdict still returned;
 *   (b) ALL candidates for a seat rate-limit too → the seat is DROPPED, but the
 *       run proceeds because quorum (2 other reviewers) still holds;
 *   (c) too many seats drop (quorum < MIN_REVIEWERS) → the WHOLE run throttles;
 *   (d) the JUDGE seat rate-limits with no fallback candidate → the WHOLE run
 *       throttles (the judge can never be dropped);
 *   (e) a NON-rate-limit seat error still degrades the WHOLE run immediately,
 *       UNCHANGED — no fallback is attempted;
 *   (f) a rebuttal depending on a dropped primary is cascade-dropped too, without
 *       deadlocking the judge (the DAG-guard).
 */
import { describe, it, expect, vi } from "vitest";
import {
  runReviewTasks,
  type ReviewGateway,
  type ReviewModelCatalogEntry,
} from "../../../server/services/consilium/review-runner.js";
import type { CreateTaskParam } from "../../../server/services/task-orchestrator.js";

const RATE_LIMIT = new Error("usage limit exceeded (429 too many requests)");

const primaryReply = (name: string): string =>
  JSON.stringify({ summary: `${name} prose`, output: { note: name }, decisions: [] });

const judgeReply = (converged: boolean, openP0: number): string =>
  JSON.stringify({
    summary: "judge summary",
    output: {
      verdict: "the verdict prose",
      pros: [],
      cons: [],
      action_points: openP0 > 0 ? [{ title: "fix it", priority: "P0" }] : [],
      convergence: {
        converged,
        open_p0: openP0,
        open_action_points: openP0 > 0 ? [{ title: "fix it", priority: "P0" }] : [],
      },
    },
  });

type Outcome = string | Error;

/**
 * Fake gateway keyed by (task name, model slug) — a per-task entry can be a FLAT
 * `Outcome` (every model call for that task gets the same result — used to
 * simulate "every candidate also rate-limits") or a `Record<slug, Outcome>` (used
 * to make ONE specific model rate-limit while another succeeds, driving rotation).
 * `calls` (optional) records every (task, model) attempt in order, for assertions
 * on rotation/no-fallback-attempted behaviour.
 */
function seatGateway(
  byTaskModel: Record<string, Record<string, Outcome> | Outcome>,
  calls: Array<{ task: string; model: string }> = [],
): ReviewGateway {
  return {
    completeStreaming: vi.fn(
      async (req: { modelSlug: string; messages: Array<{ role: string; content: string }> }) => {
        const system = req.messages.find((m) => m.role === "system")?.content ?? "";
        const taskName = Object.keys(byTaskModel).find((n) => system.includes(`Your specific task: ${n}`)) ?? "";
        calls.push({ task: taskName, model: req.modelSlug });
        const entry = byTaskModel[taskName];
        const outcome = typeof entry === "string" || entry instanceof Error ? entry : entry?.[req.modelSlug];
        if (outcome === undefined) throw new Error(`no canned reply for ${taskName}/${req.modelSlug}`);
        if (outcome instanceof Error) throw outcome;
        return { content: outcome };
      },
    ),
  };
}

/** 3 independent primaries (no rebuttals) + a judge depending on all 3. */
const panelTasks = (): CreateTaskParam[] => [
  { name: "P-A", description: "primary A", executionMode: "direct_llm", modelSlug: "anthropic-a", dependsOn: [] },
  { name: "P-B", description: "primary B", executionMode: "direct_llm", modelSlug: "google-b", dependsOn: [] },
  { name: "P-C", description: "primary C", executionMode: "direct_llm", modelSlug: "openai-c", dependsOn: [] },
  {
    name: "Judge",
    description: "judge",
    executionMode: "direct_llm",
    modelSlug: "anthropic-a",
    dependsOn: ["P-A", "P-B", "P-C"],
  },
];

const catalog: ReviewModelCatalogEntry[] = [
  { slug: "anthropic-a", provider: "anthropic" },
  { slug: "anthropic-a2", provider: "anthropic" },
  { slug: "google-b", provider: "google" },
  { slug: "google-b2", provider: "google" },
  { slug: "openai-c", provider: "openai" },
];

const base = {
  judgeTaskName: "Judge",
  groupName: "grp",
  groupInput: "THE OBJECTIVE AND DIFF",
  timeoutMs: 1000,
  activeModels: catalog,
};

describe("runReviewTasks — Part B per-seat fallback: auto-rotation", () => {
  it("(a) a non-judge seat rate-limits on its original model → rotates to a different-provider candidate, verdict still returned", async () => {
    const calls: Array<{ task: string; model: string }> = [];
    const gateway = seatGateway(
      {
        "P-A": { "anthropic-a": RATE_LIMIT, "google-b2": primaryReply("P-A") },
        "P-B": primaryReply("P-B"),
        "P-C": primaryReply("P-C"),
        Judge: judgeReply(true, 0),
      },
      calls,
    );
    const r = await runReviewTasks({ ...base, tasks: panelTasks(), gateway });

    expect(r.error).toBeUndefined();
    expect(r.rateLimited).toBeUndefined();
    expect(r.converged).toBe(true);
    const pa = (r.participants ?? []).find((p) => p.name === "P-A");
    expect(pa?.model).toBe("google-b2"); // rotated off "anthropic-a" (different provider)
    expect(pa?.text).toContain("[fell back anthropic-a→google-b2]");
    expect(calls.filter((c) => c.task === "P-A").map((c) => c.model)).toEqual(["anthropic-a", "google-b2"]);
  });
});

describe("runReviewTasks — Part B per-seat fallback: drop + quorum", () => {
  it("(b) drops a seat once ALL fallback candidates ALSO rate-limit, but proceeds because quorum (2 others) holds", async () => {
    const gateway = seatGateway({
      "P-A": primaryReply("P-A"),
      "P-B": RATE_LIMIT, // every model tried for P-B rate-limits (original + its only candidate)
      "P-C": primaryReply("P-C"),
      Judge: judgeReply(false, 1),
    });
    const r = await runReviewTasks({ ...base, tasks: panelTasks(), gateway });

    expect(r.error).toBeUndefined();
    expect(r.rateLimited).toBeUndefined();
    expect(r.converged).toBe(false);
    expect(r.openP0).toBe(1);
    const byName = Object.fromEntries((r.participants ?? []).map((p) => [p.name, p]));
    expect(byName["P-A"]).toBeTruthy();
    expect(byName["P-C"]).toBeTruthy();
    expect(byName["P-B"].text).toContain("[dropped:");
  });

  it("(c) too many seats drop (quorum < MIN_REVIEWERS) → the WHOLE run throttles", async () => {
    const gateway = seatGateway({
      "P-A": primaryReply("P-A"),
      "P-B": RATE_LIMIT,
      "P-C": RATE_LIMIT,
      Judge: judgeReply(true, 0),
    });
    const r = await runReviewTasks({ ...base, tasks: panelTasks(), gateway });

    expect(r.rateLimited).toBe(true);
    expect(r.error).toBeTruthy();
    expect(r.converged).toBe(false);
    expect(r.verdict).toBeNull();
    expect(r.participants).toBeNull();
  });

  it("(d) the JUDGE seat rate-limits with no fallback candidate available → the WHOLE run throttles", async () => {
    const gateway = seatGateway({
      "P-A": primaryReply("P-A"),
      "P-B": primaryReply("P-B"),
      "P-C": primaryReply("P-C"),
      Judge: RATE_LIMIT,
    });
    const r = await runReviewTasks({ ...base, tasks: panelTasks(), gateway, activeModels: [] });

    expect(r.rateLimited).toBe(true);
    expect(r.error).toBeTruthy();
    expect(r.converged).toBe(false);
    expect(r.verdict).toBeNull();
    expect(r.participants).toBeNull();
  });
});

describe("runReviewTasks — Part B: non-rate-limit path stays UNCHANGED", () => {
  it("(e) a NON-rate-limit seat error still degrades the WHOLE run immediately — no fallback attempted", async () => {
    const calls: Array<{ task: string; model: string }> = [];
    const gateway = seatGateway(
      {
        "P-A": primaryReply("P-A"),
        "P-B": new Error("gateway timed out reading /Users/secret/key.pem"),
        "P-C": primaryReply("P-C"),
        Judge: judgeReply(true, 0),
      },
      calls,
    );
    const r = await runReviewTasks({ ...base, tasks: panelTasks(), gateway });

    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain("/Users"); // fs path scrubbed
    expect(r.rateLimited).toBeUndefined();
    expect(r.converged).toBe(false);
    expect(r.verdict).toBeNull();
    expect(r.participants).toBeNull();
    // NOT rate-limited — rethrown immediately, no rotation attempt (exactly one call).
    expect(calls.filter((c) => c.task === "P-B")).toHaveLength(1);
  });
});

describe("runReviewTasks — Part B: DAG cascade-drop guard", () => {
  it("(f) a rebuttal depending on a dropped primary is cascade-dropped too, without deadlocking the judge", async () => {
    const tasks: CreateTaskParam[] = [
      { name: "P-A", description: "primary A", executionMode: "direct_llm", modelSlug: "anthropic-a", dependsOn: [] },
      { name: "R-A", description: "rebuts P-A", executionMode: "direct_llm", modelSlug: "anthropic-a2", dependsOn: ["P-A"] },
      { name: "P-B", description: "primary B", executionMode: "direct_llm", modelSlug: "google-b", dependsOn: [] },
      { name: "P-C", description: "primary C", executionMode: "direct_llm", modelSlug: "openai-c", dependsOn: [] },
      {
        name: "Judge",
        description: "judge",
        executionMode: "direct_llm",
        modelSlug: "google-b2",
        dependsOn: ["P-A", "R-A", "P-B", "P-C"],
      },
    ];
    const calls: Array<{ task: string; model: string }> = [];
    const gateway = seatGateway(
      {
        "P-A": RATE_LIMIT, // exhausts every candidate too — dropped
        "R-A": primaryReply("R-A"), // must NEVER be called — cascade-dropped before scheduling
        "P-B": primaryReply("P-B"),
        "P-C": primaryReply("P-C"),
        Judge: judgeReply(true, 0),
      },
      calls,
    );
    const r = await runReviewTasks({ ...base, tasks, gateway });

    expect(r.error).toBeUndefined();
    expect(r.converged).toBe(true);
    const names = (r.participants ?? []).map((p) => p.name);
    expect(names).toContain("P-B");
    expect(names).toContain("P-C");
    expect(names).not.toContain("R-A");
    expect(calls.some((c) => c.task === "R-A")).toBe(false); // never scheduled — cascade-dropped
  });
});
