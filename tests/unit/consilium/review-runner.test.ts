/**
 * review-runner.test.ts — B2 unit coverage for the PURE direct review executor
 * (`runReviewTasks`). Drives the DAG with a FAKE gateway (no model), asserting:
 *   - the full cross-review DAG (primaries∥ → rebuttals → judge) assembles a
 *     ReviewRunResult whose convergence/verdict come from the JUDGE task's parsed
 *     `.output` (byte-identical to what pickJudgeOutput/readConvergence consumed
 *     off a task execution.output) and whose participants carry the right roles;
 *   - a single-verifier round (lone task IS the judge) → no participants;
 *   - a gateway throw on ANY stage → a degraded {error} result (NEVER throws);
 *   - participant `text` is bounded (Security L-2);
 *   - prompt fidelity with executeDirectLlm — objective/diff in the SYSTEM prompt,
 *     user turn = the per-task input, temperature 0.7 / maxTokens 4096 / timeout.
 */
import { describe, it, expect, vi } from "vitest";
import { runReviewTasks, type ReviewGateway } from "../../../server/services/consilium/review-runner.js";
import type { CreateTaskParam } from "../../../server/services/task-orchestrator.js";

/** A judge reply in the canonical shape a task execution.output held. */
const judgeReply = (converged: boolean, openP0: number): string =>
  JSON.stringify({
    summary: "judge summary",
    output: {
      verdict: "the verdict prose",
      pros: ["clean tests"],
      cons: ["a gap"],
      action_points: openP0 > 0 ? [{ title: "fix it", priority: "P0" }] : [],
      convergence: {
        converged,
        open_p0: openP0,
        open_action_points: openP0 > 0 ? [{ title: "fix it", priority: "P0" }] : [],
      },
    },
  });

const debaterReply = (name: string): string =>
  JSON.stringify({ summary: `${name} review prose`, output: { note: name }, decisions: [] });

/** Fake gateway that routes a canned reply by the task name embedded in the system prompt. */
function fakeGateway(byTask: Record<string, string>): ReviewGateway {
  return {
    completeStreaming: vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const system = req.messages.find((m) => m.role === "system")?.content ?? "";
      const name = Object.keys(byTask).find((n) => system.includes(`Your specific task: ${n}`));
      return { content: byTask[name ?? ""] ?? "{}" };
    }),
  };
}

const crossReviewTasks = (): CreateTaskParam[] => [
  { name: "P-A", description: "primary A", executionMode: "direct_llm", modelSlug: "opus", dependsOn: [] },
  { name: "P-B", description: "primary B", executionMode: "direct_llm", modelSlug: "gemini", dependsOn: [] },
  { name: "R-A", description: "A rebuts B", executionMode: "direct_llm", modelSlug: "opus", dependsOn: ["P-B"] },
  { name: "R-B", description: "B rebuts A", executionMode: "direct_llm", modelSlug: "gemini", dependsOn: ["P-A"] },
  { name: "Judge", description: "judge", executionMode: "direct_llm", modelSlug: "opus", dependsOn: ["P-A", "P-B", "R-A", "R-B"] },
];

const base = {
  judgeTaskName: "Judge",
  groupName: "grp",
  groupInput: "THE OBJECTIVE AND DIFF",
  timeoutMs: 1000,
};

describe("runReviewTasks — full cross-review DAG", () => {
  it("assembles convergence + verdict from the judge output and participants with correct roles", async () => {
    const gateway = fakeGateway({
      "P-A": debaterReply("P-A"),
      "P-B": debaterReply("P-B"),
      "R-A": debaterReply("R-A"),
      "R-B": debaterReply("R-B"),
      Judge: judgeReply(false, 1),
    });
    const r = await runReviewTasks({ ...base, tasks: crossReviewTasks(), gateway });

    expect(r.error).toBeUndefined();
    // Convergence/verdict come from the JUDGE task's parsed .output, byte-identically.
    expect(r.converged).toBe(false);
    expect(r.openP0).toBe(1);
    expect(r.openActionPoints).toEqual([{ title: "fix it", priority: "P0" }]);
    expect(r.verdict).toEqual({
      verdict: "the verdict prose",
      pros: ["clean tests"],
      cons: ["a gap"],
      actionPoints: [{ title: "fix it", priority: "P0" }],
    });
    // Participants = the 4 non-judge tasks; roles from the dependency shape (order-independent).
    const byName = Object.fromEntries((r.participants ?? []).map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["P-A", "P-B", "R-A", "R-B"]);
    expect(byName["P-A"]).toEqual({ name: "P-A", model: "opus", role: "primary", text: "P-A review prose" });
    expect(byName["R-A"]).toEqual({ name: "R-A", model: "opus", role: "rebuttal", text: "R-A review prose" });
    expect(byName["R-B"].role).toBe("rebuttal");
    // The judge is NOT a participant.
    expect(byName["Judge"]).toBeUndefined();
  });

  it("runs primaries before their dependent rebuttals (dependency order)", async () => {
    const order: string[] = [];
    const gateway: ReviewGateway = {
      completeStreaming: vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
        const system = req.messages.find((m) => m.role === "system")?.content ?? "";
        const name = ["P-A", "P-B", "R-A", "R-B", "Judge"].find((n) => system.includes(`Your specific task: ${n}`))!;
        order.push(name);
        return { content: name === "Judge" ? judgeReply(true, 0) : debaterReply(name) };
      }),
    };
    await runReviewTasks({ ...base, tasks: crossReviewTasks(), gateway });
    // Each rebuttal must run after the primary it depends on; the judge runs last.
    expect(order.indexOf("R-A")).toBeGreaterThan(order.indexOf("P-B")); // R-A depends on P-B
    expect(order.indexOf("R-B")).toBeGreaterThan(order.indexOf("P-A")); // R-B depends on P-A
    expect(order[order.length - 1]).toBe("Judge");
  });
});

describe("runReviewTasks — single-verifier round (lone task IS the judge)", () => {
  it("yields the verdict from the lone task and NO participants", async () => {
    const gateway = fakeGateway({ Verifier: judgeReply(true, 0) });
    const r = await runReviewTasks({
      ...base,
      judgeTaskName: "Verifier",
      tasks: [{ name: "Verifier", description: "verify", executionMode: "direct_llm", modelSlug: "opus", dependsOn: [] }],
      gateway,
    });
    expect(r.error).toBeUndefined();
    expect(r.converged).toBe(true);
    expect(r.openP0).toBe(0);
    expect(r.participants).toEqual([]); // the lone verifier is the judge, not a participant
  });
});

describe("runReviewTasks — never throws; degrades on failure", () => {
  it("a gateway throw on any stage → a degraded {error} result (scrubbed), NOT-CONVERGED, no verdict/participants", async () => {
    const gateway: ReviewGateway = {
      completeStreaming: vi.fn(async () => {
        throw new Error("gateway timed out reading /Users/secret/key.pem");
      }),
    };
    const r = await runReviewTasks({ ...base, tasks: crossReviewTasks(), gateway });
    expect(r.error).toBeTruthy();
    expect(r.error).not.toContain("/Users"); // fs path scrubbed
    expect(r.converged).toBe(false);
    expect(r.openP0).toBe(0);
    expect(r.verdict).toBeNull();
    expect(r.participants).toBeNull();
  });
});

describe("runReviewTasks — participant text is bounded (Security L-2)", () => {
  it("clamps a huge participant text to the cap", async () => {
    const gateway = fakeGateway({
      "P-A": JSON.stringify({ summary: "x".repeat(20_000), output: {} }),
      "P-B": debaterReply("P-B"),
      "R-A": debaterReply("R-A"),
      "R-B": debaterReply("R-B"),
      Judge: judgeReply(false, 1),
    });
    const r = await runReviewTasks({ ...base, tasks: crossReviewTasks(), gateway });
    const pa = (r.participants ?? []).find((p) => p.name === "P-A");
    expect(pa?.text.length).toBe(8_000); // MAX_PARTICIPANT_TEXT
  });
});

describe("runReviewTasks — prompt fidelity with executeDirectLlm", () => {
  it("objective/diff ride the SYSTEM prompt, user turn is the per-task input, temp 0.7 / maxTokens 4096 / timeout", async () => {
    let captured: { system: string; user: string; temperature?: number; maxTokens?: number; timeout?: number } | null = null;
    const gateway: ReviewGateway = {
      completeStreaming: vi.fn(
        async (
          req: { messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number },
          _p?: unknown,
          _l?: unknown,
          streamOptions?: { overallTimeoutMs?: number },
        ) => {
          captured = {
            system: req.messages.find((m) => m.role === "system")?.content ?? "",
            user: req.messages.find((m) => m.role === "user")?.content ?? "",
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            timeout: streamOptions?.overallTimeoutMs,
          };
          return { content: judgeReply(true, 0) };
        },
      ),
    };
    await runReviewTasks({
      ...base,
      judgeTaskName: "Solo",
      groupName: "my-group",
      groupInput: "THE OBJECTIVE AND DIFF",
      timeoutMs: 555,
      tasks: [{ name: "Solo", description: "primary A desc", executionMode: "direct_llm", modelSlug: "opus", dependsOn: [] }],
      gateway,
    });
    expect(captured).not.toBeNull();
    expect(captured!.system).toContain("THE OBJECTIVE AND DIFF"); // objective+diff in SYSTEM
    expect(captured!.system).toContain("Task group: my-group");
    expect(captured!.system).toContain("Your specific task: Solo");
    expect(captured!.system).toContain("Description: primary A desc");
    expect(captured!.user).toBe("{}"); // per-task input (empty) in the user turn
    expect(captured!.temperature).toBe(0.7);
    expect(captured!.maxTokens).toBe(4096);
    expect(captured!.timeout).toBe(555);
  });
});
