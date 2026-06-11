/**
 * Consensus controller — the /consensus run lifecycle, mirroring the orchestrator
 * controller idiom but standalone (no PipelineController coupling):
 *
 *   - kill-switch enforced HERE too (defense-in-depth with the route 503);
 *   - creates a parent pipeline_runs row (owner = triggeredBy) + a consensus_runs
 *     row, then runs the ConsensusEngine to completion server-side;
 *   - a per-run AbortController in `activeRuns` powers `cancel(runId)`;
 *   - settles the consensus_runs row: resolved / unresolved / cancelled / failed.
 *     A failure persists a scrubbed reason (no swallowed errors); abort → cancelled
 *     and NO partial verdict is promoted.
 *
 * It injects the engine's TokenBudget (the C2 ceiling) and the antigravity live
 * roster source (so a missing model degrades the voter count, never substitutes).
 */
import crypto from "crypto";
import type { Gateway } from "../gateway/index";
import type { IStorage } from "../storage";
import type { ConsensusCapOverrides } from "../orchestrator/orchestrator-config";
import { resolveConsensusCaps, TokenBudget } from "../orchestrator/orchestrator-config";
import { configLoader } from "../config/loader.js";
import { scrubSecrets } from "../gateway/secret-scrub.js";
import { ConsensusVoters, type ListModelSlugs } from "./consensus-voters";
import { ConsensusEngine, type ConsensusModels } from "./consensus-engine";

export interface ConsensusStartInput {
  decisionText: string;
  workspaceId?: string;
  caps?: ConsensusCapOverrides;
}

export interface ConsensusStartResult {
  runId: string;
  status: string;
}

export class ConsensusController {
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly storage: IStorage,
    private readonly gateway: Gateway,
    private readonly models: ConsensusModels,
    /** Live antigravity slug source (defaults to discovering from the gateway). */
    private readonly listModelSlugs: ListModelSlugs = () => defaultLiveSlugs(this.gateway),
  ) {}

  /** True iff the /consensus kill-switch is enabled. */
  private isEnabled(): boolean {
    return configLoader.get().pipeline.consensus.enabled === true;
  }

  /**
   * Start a consensus run: create the parent + consensus rows, then drive the
   * engine to completion. Returns once the run has settled (bounded; the engine
   * caps rounds/voters/tokens/timeout).
   */
  async startConsensusRun(
    input: ConsensusStartInput,
    triggeredBy: string,
  ): Promise<ConsensusStartResult> {
    // Kill-switch (defense-in-depth with the route 503).
    if (!this.isEnabled()) {
      throw new Error("Consensus mode is disabled");
    }

    const caps = resolveConsensusCaps(configLoader.get(), input.caps);

    const run = await this.storage.createPipelineRun({
      pipelineId: `consensus:${crypto.randomUUID()}`,
      status: "running",
      input: input.decisionText,
      workspaceId: input.workspaceId ?? null,
      currentStageIndex: 0,
      startedAt: new Date(),
      triggeredBy,
      dagMode: false,
    });

    await this.storage.createConsensusRun({
      runId: run.id,
      decisionText: scrubSecrets(input.decisionText),
      subjectKind: "freeform",
      status: "deliberating",
      voterCount: caps.voterCount,
    });

    const abort = new AbortController();
    this.activeRuns.set(run.id, abort);

    const voters = new ConsensusVoters(this.gateway, this.listModelSlugs);
    const engine = new ConsensusEngine({
      gateway: this.gateway,
      storage: this.storage,
      voters,
      models: this.models,
    });
    const budget = new TokenBudget(caps.maxTotalTokens);

    try {
      const outcome = await engine.run({
        runId: run.id,
        decisionText: input.decisionText,
        caps,
        budget,
        signal: abort.signal,
      });
      await this.storage.updateConsensusRun(run.id, {
        status: outcome.status,
        roundsRun: outcome.roundsRun,
        stopReason: outcome.stopReason,
        confidence: outcome.confidence,
        finalVerdict: outcome.finalVerdict,
        voterCount: outcome.voterCount,
        totalTokensUsed: outcome.totalTokensUsed,
        completedAt: new Date(),
      });
      await this.storage.updatePipelineRun(run.id, {
        status: outcome.status === "resolved" ? "completed" : outcome.status,
        completedAt: new Date(),
      });
      return { runId: run.id, status: outcome.status };
    } catch (err) {
      // No swallowed errors: persist a scrubbed reason. Abort → cancelled (no
      // partial verdict promoted); any other throw → failed.
      const aborted = abort.signal.aborted;
      const reason = scrubSecrets(err instanceof Error ? err.message : String(err));
      const status = aborted ? "cancelled" : "failed";
      await this.storage.updateConsensusRun(run.id, {
        status,
        finalVerdict: null,
        error: reason,
        completedAt: new Date(),
      });
      await this.storage.updatePipelineRun(run.id, {
        status: aborted ? "cancelled" : "failed",
        completedAt: new Date(),
      });
      return { runId: run.id, status };
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  /** Cancel an in-flight consensus run (C1). No-op if not active. */
  cancel(runId: string): void {
    this.activeRuns.get(runId)?.abort();
  }

  /**
   * Read-only snapshot of the active consensus run ids. Used by the
   * /api/activity observability lens. Does not expose the AbortControllers.
   */
  getActiveRunIds(): string[] {
    return [...this.activeRuns.keys()];
  }
}

/**
 * Default live antigravity slug source: discover from the gateway and return the
 * slugs reported under the "antigravity" provider key. Never throws — an empty
 * roster simply degrades the voter count to zero.
 */
async function defaultLiveSlugs(gateway: Gateway): Promise<readonly string[]> {
  try {
    const discovered = await gateway.discoverModels();
    const entry = discovered["antigravity"];
    if (!entry || !Array.isArray(entry.models)) return [];
    return entry.models
      .map((m) => (m as { slug?: string }).slug)
      .filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}
