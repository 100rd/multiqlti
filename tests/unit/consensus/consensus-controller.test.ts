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
import type { ListModelSlugs } from "../../../server/consensus/consensus-voters.js";

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

/**
 * Reach the controller's DEFAULT live-discovery slug source (the 4th-arg default,
 * `() => defaultLiveSlugs(this.gateway)`) without re-exporting the private module
 * function. Constructed with only 3 args so the default binding is installed.
 */
function defaultSlugSource(ctrl: ConsensusController): ListModelSlugs {
  return (ctrl as unknown as { readonly listModelSlugs: ListModelSlugs }).listModelSlugs;
}

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

describe("ConsensusController — defaultLiveSlugs (live-discovery fallback)", () => {
  it("happy parse: discovered antigravity models → their slugs (no injected roster source)", async () => {
    enableConsensus(true);
    // Only 3 args → the controller installs its DEFAULT live-discovery source.
    const ctrl = new ConsensusController(new MemStorage(), makeGateway("APPROVE"), MODELS);
    const slugs = await defaultSlugSource(ctrl)();
    expect([...slugs]).toEqual([...VOTER_ROSTER]);
  });

  it("catch branch: a throwing discoverModels degrades to [] (defensive, never throws)", async () => {
    enableConsensus(true);
    const boomGateway = {
      async complete(req: GatewayRequest): Promise<GatewayResponse> {
        return { content: "{}", tokensUsed: 1, modelSlug: req.modelSlug, finishReason: "stop" };
      },
      async discoverModels(): Promise<never> {
        throw new Error("discover boom");
      },
    } as unknown as Gateway;
    const ctrl = new ConsensusController(new MemStorage(), boomGateway, MODELS);

    await expect(defaultSlugSource(ctrl)()).resolves.toEqual([]); // no-throw, empty roster
  });

  it("missing/non-array antigravity entry → [] (no slugs invented)", async () => {
    enableConsensus(true);
    const noEntryGateway = {
      async complete(req: GatewayRequest): Promise<GatewayResponse> {
        return { content: "{}", tokensUsed: 1, modelSlug: req.modelSlug, finishReason: "stop" };
      },
      async discoverModels() {
        return { someOtherProvider: { available: true, models: [{ slug: "x" }] } };
      },
    } as unknown as Gateway;
    const ctrl = new ConsensusController(new MemStorage(), noEntryGateway, MODELS);
    await expect(defaultSlugSource(ctrl)()).resolves.toEqual([]);
  });
});

describe("ConsensusController — cancel", () => {
  it("cancel() on an unknown run is a no-op (does not throw)", () => {
    enableConsensus(true);
    const ctrl = new ConsensusController(new MemStorage(), makeGateway("APPROVE"), MODELS, liveAll);
    expect(() => ctrl.cancel("nope")).not.toThrow();
  });

  it("cancel() on an ACTIVE (not-yet-settled) run settles cancelled with NO partial verdict", async () => {
    enableConsensus(true);
    const storage = new MemStorage();

    // A gateway whose FIRST complete() (the blind verdict) blocks until released,
    // so the run is genuinely in-flight (row created, engine running, not settled)
    // when we cancel(). Releasing it lets the engine reach its abort-aware stop check.
    let releaseFirst!: () => void;
    let firstCallStarted!: () => void;
    const blocked = new Promise<void>((r) => (releaseFirst = r));
    const started = new Promise<void>((r) => (firstCallStarted = r));
    let sawFirst = false;
    const gateway = {
      async complete(req: GatewayRequest): Promise<GatewayResponse> {
        if (!sawFirst) {
          sawFirst = true;
          firstCallStarted();
          await blocked; // hold the run open across the cancel()
        }
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
      async discoverModels() {
        return { antigravity: { available: true, models: VOTER_ROSTER.map((slug) => ({ slug })) } };
      },
    } as unknown as Gateway;

    const ctrl = new ConsensusController(storage, gateway, MODELS, liveAll);

    // Capture the runId the controller creates (the parent row id is the run id).
    let capturedRunId = "";
    const realCreate = storage.createPipelineRun.bind(storage);
    vi.spyOn(storage, "createPipelineRun").mockImplementation(async (data) => {
      const row = await realCreate(data);
      capturedRunId = row.id;
      return row;
    });

    const runPromise = ctrl.startConsensusRun({ decisionText: "d" }, "u1");

    await started; // the run is in-flight: row exists, blind call blocked, not settled
    expect(capturedRunId).not.toBe("");

    ctrl.cancel(capturedRunId); // abort the in-flight run
    releaseFirst(); // let the blocked call resolve so the engine reaches its stop check

    const result = await runPromise;
    expect(result.status).toBe("cancelled");

    const cr = await storage.getConsensusRun(capturedRunId);
    expect(cr?.status).toBe("cancelled");
    expect(cr?.finalVerdict).toBeNull(); // C1: no partial verdict promoted
    const parent = await storage.getPipelineRun(capturedRunId);
    expect(parent?.status).toBe("cancelled");
  });
});
