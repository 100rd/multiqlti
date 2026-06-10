/**
 * Unit tests for GroundingStep (T7).
 *
 * Behind the omniscience.board.enabled flag: flag off → {grounded:false}, no
 * call, never blocks. Flag on → composes OmniscienceBoardProvider via the
 * injected tool caller (mock-omniscience-board). Transport error → degrades
 * gracefully to {grounded:false} (non-fatal), never throws into the engine.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi } from "vitest";
import { GroundingStep } from "../../../server/orchestrator/grounding-step.js";
import { makeMockBoardCaller } from "../../helpers/mock-omniscience-board.js";

describe("GroundingStep — flag off (graceful no-op)", () => {
  it("returns {grounded:false} and makes NO call when disabled", async () => {
    const callerFactory = vi.fn();
    const step = new GroundingStep({ enabled: false, callerFactory });

    const result = await step.run({
      query: "what breaks if I change X",
      signal: new AbortController().signal,
    });

    expect(result.grounded).toBe(false);
    expect(callerFactory).not.toHaveBeenCalled();
  });
});

describe("GroundingStep — flag on", () => {
  it("queries the board and returns grounded evidence", async () => {
    const { caller } = makeMockBoardCaller();
    const step = new GroundingStep({ enabled: true, callerFactory: () => caller });

    const result = await step.run({
      query: "blast radius of service-a",
      entityId: "service-a",
      signal: new AbortController().signal,
    });

    expect(result.grounded).toBe(true);
    expect(result.evidence).toBeTruthy();
  });

  it("degrades to {grounded:false} when the board transport fails (non-fatal)", async () => {
    const { caller } = makeMockBoardCaller({ failWith: new Error("connection refused") });
    const step = new GroundingStep({ enabled: true, callerFactory: () => caller });

    const result = await step.run({
      query: "x",
      entityId: "service-a",
      signal: new AbortController().signal,
    });

    expect(result.grounded).toBe(false);
  });

  it("degrades to {grounded:false} when no caller can be constructed", async () => {
    const step = new GroundingStep({ enabled: true, callerFactory: () => null });
    const result = await step.run({ query: "x", signal: new AbortController().signal });
    expect(result.grounded).toBe(false);
  });
});
