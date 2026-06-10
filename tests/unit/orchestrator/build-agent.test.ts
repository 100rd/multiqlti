/**
 * Smoke test for buildOrchestratorAgent (DI wiring factory). Confirms it
 * constructs a usable OrchestratorAgent over real services with a mock gateway/
 * storage — no CLI/network. Keeps the wiring path covered.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, vi } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import { buildOrchestratorAgent } from "../../../server/orchestrator/build-agent.js";
import { OrchestratorAgent } from "../../../server/orchestrator/orchestrator-agent.js";

describe("buildOrchestratorAgent", () => {
  it("constructs an OrchestratorAgent with wired services", () => {
    const storage = new MemStorage();
    const gateway = {
      complete: vi.fn(),
      completeStreaming: vi.fn(),
      resolveProvider: vi.fn(),
    } as never;
    const wsManager = { broadcastToRun: vi.fn() } as never;

    const agent = buildOrchestratorAgent(storage, gateway, wsManager);
    expect(agent).toBeInstanceOf(OrchestratorAgent);
    expect(typeof agent.planAndPause).toBe("function");
    expect(typeof agent.executeApprovedPlan).toBe("function");
  });
});
