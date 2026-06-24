import { describe, it, expect, vi, beforeEach } from "vitest";
import { MetaLoopService } from "../../server/pipeline/meta-loop";
import type { OpenSpec, SpecRequirement } from "@shared/types";
import { EvaluatorWorker } from "../../server/pipeline/evaluator-worker";

// Mock the Git worktree operations so we don't actually spawn branches in tests
vi.mock("../../server/pipeline/ralph-loop", () => {
  return {
    RalphLoopManager: class {
      spawnIsolatedContext = vi.fn().mockResolvedValue({ worktreePath: "/tmp/mock-worktree", spec: {}, activeRequirement: {} });
      destroyIsolatedContext = vi.fn().mockResolvedValue(undefined);
    }
  };
});

describe("Dark Factory Architecture - MetaLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const dummySpec: OpenSpec = {
    id: "spec-1",
    title: "Test Feature",
    description: "Build a thing",
    version: "1.0",
    requirements: [
      {
        id: "req-1",
        description: "Add a button",
        acceptanceCriteria: "Button exists in DOM",
      }
    ]
  };

  it("should fail a cheating worker (Axis 6 Verification)", async () => {
    // Arrange
    const metaLoop = new MetaLoopService({ maxRetriesPerRequirement: 2, maxTotalTokens: 1000, baseRepoPath: "/" });

    // A lazy worker that does absolutely nothing
    const cheatingWorker = async (contextDir: string) => {
      // Doesn't modify files
    };

    // A test runner that correctly reports the button is NOT in the DOM
    const testRunner = async () => {
      return "FAIL: Button not found in DOM";
    };

    // We must mock the EvaluatorWorker's LLM call to simulate it correctly interpreting the test log
    const evaluateSpy = vi.spyOn(EvaluatorWorker.prototype, 'evaluateCodeAgainstSpec')
      .mockResolvedValue({
        specId: "spec-1",
        overallVerdict: "fail",
        proofs: [],
        summary: "Code failed tests. Button not found."
      });

    // Act
    const result = await metaLoop.executeAutonomousPipeline(dummySpec, cheatingWorker, testRunner);

    // Assert
    expect(result).toBe(false); // The pipeline should have failed
    expect(evaluateSpy).toHaveBeenCalledTimes(2); // It tried twice (maxRetries) and failed both
  });

  it("should gracefully stop on impossible specs (Axis 4 Stop Conditions)", async () => {
    // Arrange
    const metaLoop = new MetaLoopService({ maxRetriesPerRequirement: 3, maxTotalTokens: 1000, baseRepoPath: "/" });

    // A worker that tries its best but always fails
    const failingWorker = async (contextDir: string) => {};
    const testRunner = async () => "FAIL: Timeout";

    const evaluateSpy = vi.spyOn(EvaluatorWorker.prototype, 'evaluateCodeAgainstSpec')
      .mockResolvedValue({
        specId: "spec-1",
        overallVerdict: "fail",
        proofs: [],
        summary: "Timeout"
      });

    // Act
    const result = await metaLoop.executeAutonomousPipeline(dummySpec, failingWorker, testRunner);

    // Assert
    expect(result).toBe(false);
    expect(evaluateSpy).toHaveBeenCalledTimes(3); // Stopped exactly at max retries
  });

  it("should pass when worker satisfies evaluator (E2E Success)", async () => {
     // Arrange
     const metaLoop = new MetaLoopService({ maxRetriesPerRequirement: 2, maxTotalTokens: 1000, baseRepoPath: "/" });
 
     // A good worker
     const goodWorker = async (contextDir: string) => {};
     const testRunner = async () => "PASS: 1 tests passed";
 
     const evaluateSpy = vi.spyOn(EvaluatorWorker.prototype, 'evaluateCodeAgainstSpec')
       .mockResolvedValue({
         specId: "spec-1",
         overallVerdict: "pass",
         proofs: [],
         summary: "LGTM"
       });
 
     // Act
     const result = await metaLoop.executeAutonomousPipeline(dummySpec, goodWorker, testRunner);
 
     // Assert
     expect(result).toBe(true);
     expect(evaluateSpy).toHaveBeenCalledTimes(1); // Passed on first try
  });
});
