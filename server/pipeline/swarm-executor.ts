import type { Gateway } from "../gateway/index";
import type { TeamRegistry } from "../teams/registry";
import type { WsManager } from "../ws/manager";
import type {
  PipelineStageConfig,
  StageContext,
  SwarmConfig,
  SwarmCloneResult,
  SwarmMerger,
  SwarmResult,
  SwarmSplitter,
} from "@shared/types";

const MAX_CLONE_COUNT = 20;
const SYSTEM_PROMPT_PREVIEW_LEN = 120;
const OUTPUT_PREVIEW_LEN = 200;

export class SwarmAllFailedError extends Error {
  constructor(public readonly cloneResults: SwarmCloneResult[]) {
    super(`All ${cloneResults.length} swarm clones failed`);
    this.name = "SwarmAllFailedError";
  }
}

// ─── Built-in perspective labels per team ─────────────────────────────────────

const BUILT_IN_PERSPECTIVES: Record<string, string[]> = {
  code_review: ["Security vulnerabilities", "Performance and scalability", "Code maintainability"],
  testing: ["Unit tests", "Integration tests", "Edge cases and error handling"],
  architecture: ["Scalability", "Cost optimization"],
  planning: ["User stories", "Technical tasks", "Risk analysis"],
};

function getDefaultPerspectives(teamId: string, count: number): string[] {
  const labels = BUILT_IN_PERSPECTIVES[teamId];
  if (labels && labels.length >= count) return labels.slice(0, count);
  return Array.from({ length: count }, (_, i) => `Perspective ${i + 1}`);
}

// ─── Chunk splitter helpers ────────────────────────────────────────────────────

function splitIntoChunks(text: string, count: number): string[] {
  if (count <= 1) return [text];
  const lines = text.split("\n");
  const chunkSize = Math.ceil(lines.length / count);
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const slice = lines.slice(i * chunkSize, (i + 1) * chunkSize);
    chunks.push(slice.join("\n"));
  }
  return chunks.filter((c) => c.trim().length > 0);
}

// ─── Clone input builders ──────────────────────────────────────────────────────

interface CloneInput {
  input: string;
  systemPromptOverride: string;
}

function buildChunkInputs(
  swarm: SwarmConfig,
  input: string,
  basePrompt: string,
): CloneInput[] {
  const chunks = splitIntoChunks(input, swarm.cloneCount);
  return chunks.map((chunk) => ({ input: chunk, systemPromptOverride: basePrompt }));
}

function buildPerspectiveInputs(
  swarm: SwarmConfig,
  input: string,
  basePrompt: string,
  teamId: string,
): CloneInput[] {
  const perspectiveLabels: string[] =
    swarm.perspectives && swarm.perspectives.length === swarm.cloneCount
      ? swarm.perspectives.map((p) => p.systemPromptSuffix)
      : getDefaultPerspectives(teamId, swarm.cloneCount).map(
          (label) => `Focus specifically on: ${label}`,
        );

  return perspectiveLabels.map((suffix) => ({
    input,
    systemPromptOverride: basePrompt ? `${basePrompt}\n\n${suffix}` : suffix,
  }));
}

function buildCustomInputs(swarm: SwarmConfig, input: string): CloneInput[] {
  const prompts = swarm.customClonePrompts ?? [];
  return prompts.map((override) => ({ input, systemPromptOverride: override }));
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

function mergeConcatenate(succeeded: SwarmCloneResult[]): string {
  return succeeded
    .map((r) => `## Clone ${r.cloneIndex + 1}\n\n${r.output ?? ""}`)
    .join("\n\n---\n\n");
}

function tryParseVoteValue(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed === "true" || trimmed === "false") return trimmed;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^\w+$/.test(trimmed)) return trimmed;
  return null;
}

function mergeVote(succeeded: SwarmCloneResult[]): string {
  const parsed = succeeded.map((r) => tryParseVoteValue(r.output ?? ""));
  const allParseable = parsed.every((v) => v !== null);
  if (!allParseable) {
    console.warn("[SwarmExecutor] vote merger: unstructured outputs — falling back to concatenate");
    return mergeConcatenate(succeeded);
  }
  const tally = new Map<string, number>();
  for (const v of parsed as string[]) {
    tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  let winner = parsed[0] as string;
  let max = 0;
  for (const [val, count] of tally) {
    if (count > max) { max = count; winner = val; }
  }
  return winner;
}

async function mergeLlm(
  succeeded: SwarmCloneResult[],
  modelSlug: string,
  gateway: Gateway,
): Promise<string> {
  const formatted = succeeded
    .map((r, i) => `### Output ${i + 1} (Clone ${r.cloneIndex + 1})\n\n${r.output ?? ""}`)
    .join("\n\n---\n\n");
  const prompt = `You are merging ${succeeded.length} parallel analyses into one coherent result.\n\nOutputs:\n\n${formatted}\n\nProduce a unified synthesis.`;
  const response = await gateway.complete({
    modelSlug,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content;
}

// ─── SwarmExecutor ────────────────────────────────────────────────────────────

export class SwarmExecutor {
  constructor(
    private readonly gateway: Gateway,
    private readonly teamRegistry: TeamRegistry,
    private readonly wsManager: WsManager,
  ) {}

  shouldSwarm(stage: PipelineStageConfig): boolean {
    return stage.swarm?.enabled === true && (stage.swarm?.cloneCount ?? 0) > 1;
  }

  async execute(
    stage: PipelineStageConfig,
    stageInput: string,
    context: StageContext,
    stageId: string,
  ): Promise<SwarmResult | null> {
    const swarm = stage.swarm;
    if (!swarm?.enabled) return null;
    if (swarm.cloneCount > MAX_CLONE_COUNT) {
      throw new Error(`cloneCount ${swarm.cloneCount} exceeds maximum of ${MAX_CLONE_COUNT}`);
    }

    const start = Date.now();
    this.broadcastSwarmStarted(context.runId, stageId, swarm);

    const cloneInputs = this.buildCloneInputs(swarm, stageInput, stage);
    const settled = await Promise.allSettled(
      cloneInputs.map((ci, i) => this.runClone(stage, ci, context, stageId, i)),
    );

    const cloneResults: SwarmCloneResult[] = settled.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            cloneIndex: i,
            status: "failed" as const,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            tokensUsed: 0,
            durationMs: 0,
            systemPromptPreview: cloneInputs[i]?.systemPromptOverride.slice(0, SYSTEM_PROMPT_PREVIEW_LEN) ?? "",
          },
    );

    const succeeded = cloneResults.filter((r): r is SwarmCloneResult & { status: "succeeded" } =>
      r.status === "succeeded",
    );

    if (succeeded.length === 0) {
      throw new SwarmAllFailedError(cloneResults);
    }

    this.broadcastSwarmMerging(context.runId, stageId, swarm.merger, succeeded.length);

    const mergerModelSlug = swarm.mergerModelSlug ?? stage.modelSlug;
    const mergedOutput = await this.mergeOutputs(swarm, succeeded, mergerModelSlug);
    const totalTokensUsed = cloneResults.reduce((sum, r) => sum + r.tokensUsed, 0);
    const durationMs = Date.now() - start;

    this.broadcastSwarmCompleted(context.runId, stageId, {
      succeededCount: succeeded.length,
      failedCount: cloneResults.length - succeeded.length,
      totalTokensUsed,
      durationMs,
    });

    return {
      mergedOutput,
      cloneResults,
      succeededCount: succeeded.length,
      failedCount: cloneResults.length - succeeded.length,
      totalTokensUsed,
      mergerUsed: swarm.merger,
      splitterUsed: swarm.splitter,
      durationMs,
    };
  }

  private buildCloneInputs(
    swarm: SwarmConfig,
    input: string,
    stage: PipelineStageConfig,
  ): CloneInput[] {
    const basePrompt = stage.systemPromptOverride ?? "";
    const splitter: SwarmSplitter = swarm.splitter;
    if (splitter === "chunks") return buildChunkInputs(swarm, input, basePrompt);
    if (splitter === "custom") return buildCustomInputs(swarm, input);
    return buildPerspectiveInputs(swarm, input, basePrompt, stage.teamId);
  }

  private async runClone(
    stage: PipelineStageConfig,
    cloneInput: CloneInput,
    context: StageContext,
    stageId: string,
    cloneIndex: number,
  ): Promise<SwarmCloneResult> {
    const systemPromptPreview = cloneInput.systemPromptOverride.slice(0, SYSTEM_PROMPT_PREVIEW_LEN);
    this.broadcastCloneStarted(context.runId, stageId, cloneIndex, systemPromptPreview);

    const start = Date.now();
    try {
      const team = this.teamRegistry.getTeam(stage.teamId);
      const cloneContext: StageContext = { ...context, stageConfig: { ...stage, systemPromptOverride: cloneInput.systemPromptOverride } };
      const result = await team.execute({ taskDescription: cloneInput.input }, cloneContext);
      const output = typeof result.output.raw === "string"
        ? result.output.raw
        : JSON.stringify(result.output);

      const durationMs = Date.now() - start;
      this.broadcastCloneCompleted(context.runId, stageId, cloneIndex, result.tokensUsed, output);

      return { cloneIndex, status: "succeeded", output, tokensUsed: result.tokensUsed, durationMs, systemPromptPreview };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.broadcastCloneFailed(context.runId, stageId, cloneIndex, error);
      return { cloneIndex, status: "failed", error, tokensUsed: 0, durationMs: Date.now() - start, systemPromptPreview };
    }
  }

  private async mergeOutputs(
    swarm: SwarmConfig,
    succeeded: SwarmCloneResult[],
    mergerModelSlug: string,
  ): Promise<string> {
    const merger: SwarmMerger = swarm.merger;
    if (merger === "concatenate") return mergeConcatenate(succeeded);
    if (merger === "vote") return mergeVote(succeeded);
    return mergeLlm(succeeded, mergerModelSlug, this.gateway);
  }

  // ─── WS broadcast helpers ─────────────────────────────────────────────────

  private broadcastSwarmStarted(runId: string, stageId: string, swarm: SwarmConfig): void {
    this.wsManager.broadcastToRun(runId, {
      type: "swarm:started",
      runId,
      payload: { stageId, cloneCount: swarm.cloneCount, splitter: swarm.splitter, merger: swarm.merger },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastCloneStarted(runId: string, stageId: string, cloneIndex: number, systemPromptPreview: string): void {
    this.wsManager.broadcastToRun(runId, {
      type: "swarm:clone:started",
      runId,
      payload: { stageId, cloneIndex, systemPromptPreview },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastCloneCompleted(runId: string, stageId: string, cloneIndex: number, tokensUsed: number, output: string): void {
    this.wsManager.broadcastToRun(runId, {
      type: "swarm:clone:completed",
      runId,
      payload: { stageId, cloneIndex, tokensUsed, outputPreview: output.slice(0, OUTPUT_PREVIEW_LEN) },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastCloneFailed(runId: string, stageId: string, cloneIndex: number, error: string): void {
    this.wsManager.broadcastToRun(runId, {
      type: "swarm:clone:failed",
      runId,
      payload: { stageId, cloneIndex, error },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastSwarmMerging(runId: string, stageId: string, strategy: SwarmMerger, succeededClones: number): void {
    this.wsManager.broadcastToRun(runId, {
      type: "swarm:merging",
      runId,
      payload: { stageId, strategy, succeededClones },
      timestamp: new Date().toISOString(),
    });
  }

  private broadcastSwarmCompleted(
    runId: string,
    stageId: string,
    info: { succeededCount: number; failedCount: number; totalTokensUsed: number; durationMs: number },
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type: "swarm:completed",
      runId,
      payload: { stageId, ...info },
      timestamp: new Date().toISOString(),
    });
  }
}
