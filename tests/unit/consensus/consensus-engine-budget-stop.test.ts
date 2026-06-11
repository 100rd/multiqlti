/**
 * Gap-2 coverage: the ConsensusEngine round-boundary stop branch for
 * decideStop reason "budget".
 *
 * In production this branch is unreachable because the engine passes
 * `budgetExhausted: false` to shouldStop (the C2 ceiling is enforced eagerly by
 * TokenBudget.checkBefore(), which THROWS a TokenCeilingError before any round
 * boundary). To exercise the engine's defensive handling of a non-throwing
 * `{stop:true, reason:"budget"}` decision (consensus-engine.ts lines ~197-205),
 * we stub the shared `shouldStop` seam so it returns that decision directly.
 *
 * The assertion is the safety contract: a budget stop settles UNRESOLVED with a
 * null finalVerdict — a partial / would-be APPROVE is NEVER promoted — and no
 * TokenCeilingError was thrown (the run returns an outcome, it does not reject).
 *
 * The mock is file-scoped (vi.mock is hoisted), so this lives in its own file to
 * avoid altering the real-policy assertions in consensus-engine.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import type { StopDecision } from "../../../server/orchestrator/deliberation/stop-policy.js";

// Stub the shared termination seam to force a non-throwing budget stop, keeping
// the sibling export intact (the engine only uses shouldStop, but we preserve
// the real module shape rather than blank it out).
vi.mock("../../../server/orchestrator/deliberation/deliberation-controller.js", async (importActual) => {
  const actual = await importActual<
    typeof import("../../../server/orchestrator/deliberation/deliberation-controller.js")
  >();
  const budgetStop: StopDecision = { stop: true, reason: "budget", confidence: "low" };
  return {
    ...actual,
    shouldStop: vi.fn((): StopDecision => budgetStop),
  };
});

import { MemStorage } from "../../../server/storage.js";
import { ConsensusEngine } from "../../../server/consensus/consensus-engine.js";
import { ConsensusVoters, VOTER_ROSTER } from "../../../server/consensus/consensus-voters.js";
import { TokenBudget } from "../../../server/orchestrator/orchestrator-config.js";
import type { GatewayRequest, GatewayResponse } from "../../../shared/types.js";
import type { Gateway } from "../../../server/gateway/index.js";

const CLAUDE = "claude-opus";

/**
 * Voters + Claude all APPROVE — so the ONLY thing that can block a resolve is the
 * stubbed budget stop (proving it pre-empts a would-be APPROVE).
 */
function makeApprovingGateway(): Gateway {
  return {
    async complete(req: GatewayRequest): Promise<GatewayResponse> {
      const isVoter = req.provider === "antigravity";
      return {
        content: isVoter
          ? JSON.stringify({ verdict: "APPROVE", critical_issues: [] })
          : JSON.stringify({ verdict: "APPROVE" }),
        tokensUsed: 1,
        modelSlug: req.modelSlug,
        finishReason: "stop",
      };
    },
  } as unknown as Gateway;
}

async function seedRun(storage: MemStorage): Promise<string> {
  const run = await storage.createPipelineRun({
    pipelineId: "consensus:budget-test",
    status: "running",
    input: "decision",
    triggeredBy: "u1",
  });
  await storage.createConsensusRun({ runId: run.id, decisionText: "d", status: "deliberating" });
  return run.id;
}

describe("ConsensusEngine — budget stop on a round boundary (no TokenCeilingError throw)", () => {
  it('a non-throwing decideStop {reason:"budget"} settles unresolved, finalVerdict null (no partial promoted)', async () => {
    const storage = new MemStorage();
    const runId = await seedRun(storage);
    const budget = new TokenBudget(1_000_000); // far from its ceiling — no throw
    const voters = new ConsensusVoters(makeApprovingGateway(), () => Promise.resolve([...VOTER_ROSTER]));
    const engine = new ConsensusEngine({
      gateway: makeApprovingGateway(),
      storage,
      voters,
      models: { claudeModelSlug: CLAUDE },
    });

    const outcome = await engine.run({
      runId,
      decisionText: "d",
      // minRounds 1 so the first round can reach the (stubbed) stop check.
      caps: {
        maxRounds: 3,
        voterCount: 5,
        maxTotalTokens: 1_000_000,
        overallTimeoutMs: 1_800_000,
        voterTimeoutMs: 90_000,
        minRounds: 1,
      },
      budget,
    });

    expect(outcome.status).toBe("unresolved");
    expect(outcome.stopReason).toBe("budget");
    expect(outcome.confidence).toBe("low");
    expect(outcome.finalVerdict).toBeNull(); // C2: no partial / would-be APPROVE promoted
    expect(outcome.roundsRun).toBe(1);
    // The budget never hit its ceiling — this exercised the defensive branch,
    // NOT the TokenCeilingError throw path.
    expect(budget.total).toBeLessThan(1_000_000);
  });
});
