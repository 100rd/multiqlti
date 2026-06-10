/**
 * Unit tests for the ConsensusVoters fan-out (QA Section 5).
 *   - T-CONS-FANOUT-1 bounded to min(voterCount, roster∩live);
 *   - T-CONS-FANOUT-2 INDEPENDENCE (MF-5/M-1): every voter prompt is byte-identical
 *     modulo the pinned slug; NO claudeVerdict / sibling output appears; H-2 pins
 *     provider:"antigravity" + modelId per call;
 *   - T-CONS-FANOUT-3 fail-CLOSED: unparseable + rejected-promise voters →
 *     REQUEST_CHANGES (never APPROVE);
 *   - H-1: the engine-owned TokenBudget is checked + accumulated per call.
 *
 * Deterministic: a scripted gateway double + an injected live-roster source.
 */
import { describe, it, expect } from "vitest";
import {
  ConsensusVoters,
  VOTER_ROSTER,
  resolveVoterSlugs,
} from "../../../server/consensus/consensus-voters.js";
import { TokenBudget } from "../../../server/orchestrator/orchestrator-config.js";
import type { GatewayRequest, GatewayResponse } from "../../../shared/types.js";
import type { Gateway } from "../../../server/gateway/index.js";

class ScriptedGateway {
  public calls: GatewayRequest[] = [];
  constructor(
    private readonly behavior: (req: GatewayRequest) => GatewayResponse | Promise<GatewayResponse>,
  ) {}
  async complete(request: GatewayRequest): Promise<GatewayResponse> {
    this.calls.push(request);
    return this.behavior(request);
  }
}

function makeGateway(
  behavior: (req: GatewayRequest) => GatewayResponse | Promise<GatewayResponse>,
): { gateway: Gateway; scripted: ScriptedGateway } {
  const scripted = new ScriptedGateway(behavior);
  return { gateway: scripted as unknown as Gateway, scripted };
}

const approve = (): GatewayResponse => ({
  content: '{"verdict": "APPROVE", "critical_issues": []}',
  tokensUsed: 5,
  modelSlug: "x",
  finishReason: "stop",
});

const liveAll = () => Promise.resolve([...VOTER_ROSTER]);

describe("resolveVoterSlugs — bounded to min(count, roster∩live)", () => {
  it("T-CONS-FANOUT-1 takes the first `count` of the roster intersected with live", () => {
    expect(resolveVoterSlugs(5, VOTER_ROSTER)).toEqual(VOTER_ROSTER.slice(0, 5));
  });

  it("degrades the count when a live model is missing (NEVER substitutes)", () => {
    const live = VOTER_ROSTER.filter((s) => s !== "gemini-3-5-flash-high");
    const slugs = resolveVoterSlugs(5, live);
    expect(slugs).not.toContain("gemini-3-5-flash-high");
    expect(slugs.length).toBe(4); // degraded from 5
  });

  it("empty live roster → empty fan-out (no Claude/mock substitution)", () => {
    expect(resolveVoterSlugs(7, [])).toEqual([]);
  });
});

describe("ConsensusVoters.fanOut — independence (MF-5/M-1) + H-2 pin", () => {
  it("T-CONS-FANOUT-2 pins provider+modelId and uses byte-identical prompts modulo slug", async () => {
    const { gateway, scripted } = makeGateway(approve);
    const voters = new ConsensusVoters(gateway, liveAll);
    await voters.fanOut({
      framedDecision: "=== BEGIN UNTRUSTED DATA === decision === END ===",
      planRevision: "plan v1",
      voterCount: 5,
      budget: new TokenBudget(1_000_000),
      voterTimeoutMs: 90_000,
    });

    expect(scripted.calls).toHaveLength(5);
    for (const call of scripted.calls) {
      // H-2: pinned provider + modelId (== modelSlug).
      expect(call.provider).toBe("antigravity");
      expect(call.modelId).toBe(call.modelSlug);
    }
    // Independence: the message bodies are byte-identical across voters.
    const bodies = scripted.calls.map((c) => JSON.stringify(c.messages));
    expect(new Set(bodies).size).toBe(1);
    // No claudeVerdict / blind verdict / sibling review leaked into any prompt.
    for (const body of bodies) {
      expect(body.toLowerCase()).not.toContain("claudeverdict");
      expect(body.toLowerCase()).not.toContain("blind verdict");
      expect(body.toLowerCase()).not.toContain("other reviewer said");
    }
    // The slugs are the distinct roster entries (one unique slug per call).
    const slugs = scripted.calls.map((c) => c.modelSlug);
    expect(new Set(slugs).size).toBe(5);
  });

  it("the prompt contains the framed decision + plan revision only", async () => {
    const { gateway, scripted } = makeGateway(approve);
    const voters = new ConsensusVoters(gateway, liveAll);
    await voters.fanOut({
      framedDecision: "FRAMED-DECISION-MARKER",
      planRevision: "PLAN-MARKER",
      voterCount: 5,
      budget: new TokenBudget(1_000_000),
      voterTimeoutMs: 90_000,
    });
    const body = JSON.stringify(scripted.calls[0].messages);
    expect(body).toContain("FRAMED-DECISION-MARKER");
    expect(body).toContain("PLAN-MARKER");
  });
});

describe("ConsensusVoters.fanOut — fail-CLOSED (T-CONS-FANOUT-3)", () => {
  it("an unparseable voter → REQUEST_CHANGES (never APPROVE)", async () => {
    let n = 0;
    const { gateway } = makeGateway(() => {
      n += 1;
      // First voter returns garbage; rest approve.
      return n === 1
        ? { content: "I totally approve!!", tokensUsed: 1, modelSlug: "x", finishReason: "stop" }
        : approve();
    });
    const voters = new ConsensusVoters(gateway, liveAll);
    const results = await voters.fanOut({
      framedDecision: "d",
      planRevision: "p",
      voterCount: 5,
      budget: new TokenBudget(1_000_000),
      voterTimeoutMs: 90_000,
    });
    const garbage = results[0];
    expect(garbage.verdict).toBe("REQUEST_CHANGES");
    expect(garbage.parseError).toBeDefined();
  });

  it("a rejected voter promise does NOT sink the round (recorded REQUEST_CHANGES)", async () => {
    let n = 0;
    const { gateway } = makeGateway(() => {
      n += 1;
      return n === 2
        ? Promise.reject(new Error("voter CLI timed out"))
        : Promise.resolve(approve());
    });
    const voters = new ConsensusVoters(gateway, liveAll);
    const results = await voters.fanOut({
      framedDecision: "d",
      planRevision: "p",
      voterCount: 5,
      budget: new TokenBudget(1_000_000),
      voterTimeoutMs: 90_000,
    });
    expect(results).toHaveLength(5);
    const failed = results.find((r) => r.parseError === "call-failed");
    expect(failed?.verdict).toBe("REQUEST_CHANGES");
    // The other voters still approved.
    expect(results.filter((r) => r.verdict === "APPROVE").length).toBe(4);
  });
});

describe("ConsensusVoters.fanOut — H-1 token budget", () => {
  it("an ALREADY-exhausted budget fails every voter closed (no APPROVE manufactured)", async () => {
    const { gateway } = makeGateway(() => ({
      content: '{"verdict":"APPROVE"}',
      tokensUsed: 10_000,
      modelSlug: "x",
      finishReason: "stop",
    }));
    const budget = new TokenBudget(100);
    budget.add(100); // pre-exhaust → every checkBefore() throws at dispatch
    const voters = new ConsensusVoters(gateway, liveAll);
    const results = await voters.fanOut({
      framedDecision: "d",
      planRevision: "p",
      voterCount: 5,
      budget,
      voterTimeoutMs: 90_000,
    });
    expect(results).toHaveLength(5);
    // Every voter is fail-closed by the ceiling; NONE is an APPROVE.
    expect(results.every((r) => r.parseError === "call-failed")).toBe(true);
    expect(results.some((r) => r.verdict === "APPROVE")).toBe(false);
  });

  it("accumulates token usage across voters", async () => {
    const { gateway } = makeGateway(approve);
    const voters = new ConsensusVoters(gateway, liveAll);
    const budget = new TokenBudget(1_000_000);
    await voters.fanOut({
      framedDecision: "d",
      planRevision: "p",
      voterCount: 5,
      budget,
      voterTimeoutMs: 90_000,
    });
    expect(budget.total).toBe(25); // 5 voters * 5 tokens
  });
});
