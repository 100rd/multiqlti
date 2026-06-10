/**
 * Unit tests for the ConsensusController lifecycle: kill-switch refusal, the
 * resolved/unresolved/failed settle paths (no swallowed errors), and cancel().
 * Deterministic over MemStorage + a scripted gateway + a config-loader spy.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { MemStorage } from "../../../server/storage.js";
import { ConsensusController } from "../../../server/consensus/consensus-controller.js";
import { configLoader } from "../../../server/config/loader.js";
import type { GatewayRequest, GatewayResponse } from "../../../shared/types.js";
import type { Gateway } from "../../../server/gateway/index.js";
import { VOTER_ROSTER } from "../../../server/consensus/consensus-voters.js";

afterEach(() => vi.restoreAllMocks());

function enableConsensus(enabled: boolean): void {
  const base = configLoader.get();
  vi.spyOn(configLoader, "get").mockReturnValue({
    ...base,
    pipeline: { ...base.pipeline, consensus: { ...base.pipeline.consensus, enabled } },
  } as never);
}

/** Gateway double: all turns return the configured verdict; live roster = full. */
function makeGateway(verdict: string, throwOnComplete = false): Gateway {
  return {
    async complete(req: GatewayRequest): Promise<GatewayResponse> {
      if (throwOnComplete) throw new Error("gateway boom");
      const isVoter = req.provider === "antigravity";
      return {
        content: isVoter ? JSON.stringify({ verdict, critical_issues: [] }) : JSON.stringify({ verdict }),
        tokensUsed: 1,
        modelSlug: req.modelSlug,
        finishReason: "stop",
      };
    },
    async discoverModels() {
      return { antigravity: { available: true, models: VOTER_ROSTER.map((slug) => ({ slug })) } };
    },
  } as unknown as Gateway;
}

const MODELS = { claudeModelSlug: "claude-opus" };
const liveAll = () => Promise.resolve([...VOTER_ROSTER]);

describe("ConsensusController — kill-switch", () => {
  it("throws when consensus is disabled (defense-in-depth with the route 503)", async () => {
    enableConsensus(false);
    const storage = new MemStorage();
    const ctrl = new ConsensusController(storage, makeGateway("APPROVE"), MODELS, liveAll);
    await expect(ctrl.startConsensusRun({ decisionText: "d" }, "u1")).rejects.toThrow(/disabled/i);
  });
});

describe("ConsensusController — settle paths", () => {
  it("resolved when all conditions are met (persists final verdict + completes parent)", async () => {
    enableConsensus(true);
    const storage = new MemStorage();
    const ctrl = new ConsensusController(storage, makeGateway("APPROVE"), MODELS, liveAll);
    const { runId, status } = await ctrl.startConsensusRun({ decisionText: "d" }, "u1");
    expect(status).toBe("resolved");

    const cr = await storage.getConsensusRun(runId);
    expect(cr?.status).toBe("resolved");
    expect(cr?.finalVerdict).toBe("APPROVE");
    expect(cr?.completedAt).toBeTruthy();
    const parent = await storage.getPipelineRun(runId);
    expect(parent?.status).toBe("completed");
  });

  it("unresolved when voters reject (never auto-approve)", async () => {
    enableConsensus(true);
    const storage = new MemStorage();
    const ctrl = new ConsensusController(storage, makeGateway("REJECT"), MODELS, liveAll);
    const { runId, status } = await ctrl.startConsensusRun({ decisionText: "d" }, "u1");
    expect(status).toBe("unresolved");
    const cr = await storage.getConsensusRun(runId);
    expect(cr?.finalVerdict).toBeNull();
  });

  it("failed (no swallowed errors): a gateway throw settles failed with a scrubbed reason", async () => {
    enableConsensus(true);
    const storage = new MemStorage();
    const ctrl = new ConsensusController(storage, makeGateway("APPROVE", true), MODELS, liveAll);
    const { runId, status } = await ctrl.startConsensusRun({ decisionText: "d" }, "u1");
    expect(status).toBe("failed");
    const cr = await storage.getConsensusRun(runId);
    expect(cr?.status).toBe("failed");
    expect(cr?.error).toContain("boom");
    expect(cr?.finalVerdict).toBeNull();
    const parent = await storage.getPipelineRun(runId);
    expect(parent?.status).toBe("failed");
  });

  it("the run is owned by triggeredBy", async () => {
    enableConsensus(true);
    const storage = new MemStorage();
    const ctrl = new ConsensusController(storage, makeGateway("APPROVE"), MODELS, liveAll);
    const { runId } = await ctrl.startConsensusRun({ decisionText: "d" }, "owner-X");
    const parent = await storage.getPipelineRun(runId);
    expect(parent?.triggeredBy).toBe("owner-X");
  });
});

describe("ConsensusController — cancel", () => {
  it("cancel() on an unknown run is a no-op (does not throw)", () => {
    enableConsensus(true);
    const ctrl = new ConsensusController(new MemStorage(), makeGateway("APPROVE"), MODELS, liveAll);
    expect(() => ctrl.cancel("nope")).not.toThrow();
  });
});
