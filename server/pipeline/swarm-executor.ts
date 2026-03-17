import type { Gateway } from "../gateway/index.js";
import type { TeamRegistry } from "../teams/registry.js";
import type { WsManager } from "../ws/manager.js";
import type {
  PipelineStageConfig,
  StageContext,
  SwarmConfig,
  SwarmCloneResult,
  SwarmMerger,
  SwarmPerspective,
  SwarmResult,
  SwarmSplitter,
} from "@shared/types";

// ─── Error class ──────────────────────────────────────────────────────────────

export class SwarmAllFailedError extends Error {
  constructor(public readonly cloneResults: SwarmCloneResult[]) {
    super(`All ${cloneResults.length} swarm clones failed`);
    this.name = "SwarmAllFailedError";
  }
}

// ─── Clone input descriptor ───────────────────────────────────────────────────

interface CloneInput {
  input: string;
  systemPromptOverride: string;
  userPromptPortion: string;
}

// ─── SwarmExecutor ────────────────────────────────────────────────────────────

export class SwarmExecutor {
  constructor(
    private readonly gateway: Gateway,
    private readonly teamRegistry: TeamRegistry,
    private readonly wsManager: WsManager,
  ) {}

  async execute(
    stage: PipelineStageConfig,
    stageInput: string,
    context: StageContext,
    stageId: string,
  ): Promise<SwarmResult | null> {
    const swarm = stage.swarm;
    if (!swarm || !swarm.enabled) return null;

    // Defense-in-depth: enforce cloneCount cap even if Zod was bypassed
    if (swarm.cloneCount > 20) {
      throw new Error(`swarm.cloneCount ${swarm.cloneCount} exceeds hard cap of 20`);
    }

    const runId = context.runId;

    this.broadcast(runId, stageId, "swarm:started", {
      cloneCount: swarm.cloneCount,
      splitter: swarm.splitter,
      merger: swarm.merger,
    });

    const cloneInputs = await this.buildCloneInputs(swarm, stageInput, stage);
    const start = Date.now();

    const MAX_CONCURRENCY = parseInt(process.env.SWARM_MAX_CONCURRENCY ?? "5", 10);
    const cloneResults = await this.runClonesWithConcurrency(cloneInputs, stage, context, stageId, MAX_CONCURRENCY);

    const succeeded = cloneResults.filter((r): r is SwarmCloneResult & { status: "succeeded" } =>
      r.status === "succeeded",
    );

    if (succeeded.length === 0) {
      throw new SwarmAllFailedError(cloneResults);
    }

    this.broadcast(runId, stageId, "swarm:merging", {
      strategy: swarm.merger,
      succeededClones: succeeded.length,
    });

    const mergedOutput = await this.mergeOutputs(swarm, succeeded, stage);

    const totalTokensUsed = cloneResults.reduce((sum, r) => sum + r.tokensUsed, 0);
    const durationMs = Date.now() - start;

    this.broadcast(runId, stageId, "swarm:completed", {
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

  // ─── buildCloneInputs ──────────────────────────────────────────────────────

  private async buildCloneInputs(
    swarm: SwarmConfig,
    input: string,
    stage: PipelineStageConfig,
  ): Promise<CloneInput[]> {
    switch (swarm.splitter) {
      case "chunks":
        return this.buildChunkInputs(swarm, input, stage);
      case "perspectives":
        return this.buildPerspectiveInputs(swarm, input, stage);
      case "custom":
        return this.buildCustomInputs(swarm, input);
    }
  }

  /**
   * chunks: split input text into N approximately equal parts using newline boundaries.
   * Each clone gets its chunk and the unmodified base system prompt.
   */
  private buildChunkInputs(
    swarm: SwarmConfig,
    input: string,
    stage: PipelineStageConfig,
  ): CloneInput[] {
    const basePrompt = stage.systemPromptOverride ?? "";
    const n = swarm.cloneCount;

    if (n <= 0) return [];

    // Split by newlines into segments, then group segments into N chunks
    const lines = input.split("\n");
    const totalLines = lines.length;
    const chunkSize = Math.ceil(totalLines / n);

    const chunks: string[] = [];
    for (let i = 0; i < n; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalLines);
      const chunk = lines.slice(start, end).join("\n");
      // Even if a chunk is empty (when input has fewer lines than n), still include it
      chunks.push(chunk);
    }

    // If we have fewer lines than n, some chunks may be empty — distribute remaining content
    // by character count as a fallback for very short inputs
    if (lines.length < n && input.length > 0) {
      const charChunkSize = Math.ceil(input.length / n);
      const charChunks: string[] = [];
      for (let i = 0; i < n; i++) {
        charChunks.push(input.slice(i * charChunkSize, (i + 1) * charChunkSize));
      }
      return charChunks.map((chunk) => ({
        input: chunk,
        systemPromptOverride: basePrompt,
        userPromptPortion: "",
      }));
    }

    return chunks.map((chunk) => ({
      input: chunk,
      systemPromptOverride: basePrompt,
      userPromptPortion: "",
    }));
  }

  /**
   * perspectives: all clones get full input; each gets a unique systemPrompt suffix.
   * Perspectives are taken from swarm.perspectives if provided and correct length,
   * otherwise auto-generated via a single LLM call.
   */
  private async buildPerspectiveInputs(
    swarm: SwarmConfig,
    input: string,
    stage: PipelineStageConfig,
  ): Promise<CloneInput[]> {
    const basePrompt = stage.systemPromptOverride ?? "";
    const n = swarm.cloneCount;

    let perspectives: SwarmPerspective[];

    if (swarm.perspectives && swarm.perspectives.length === n) {
      perspectives = swarm.perspectives;
    } else {
      perspectives = await this.autoGeneratePerspectives(swarm, stage, n);
    }

    if (perspectives.length !== n) {
      throw new Error(
        `perspectives auto-generation returned ${perspectives.length} perspectives but cloneCount is ${n}`,
      );
    }

    return perspectives.map((perspective) => ({
      input,
      systemPromptOverride: basePrompt
        ? `${basePrompt}\n\nYour perspective: ${perspective.systemPromptSuffix}`
        : `Your perspective: ${perspective.systemPromptSuffix}`,
      userPromptPortion: perspective.systemPromptSuffix,
    }));
  }

  private async autoGeneratePerspectives(
    swarm: SwarmConfig,
    stage: PipelineStageConfig,
    n: number,
  ): Promise<SwarmPerspective[]> {
    const stageDescription = stage.systemPromptOverride ?? stage.teamId;
    const modelSlug = swarm.mergerModelSlug ?? stage.modelSlug;

    const prompt = `Generate ${n} distinct expert review perspectives for a stage described as: ${stageDescription}. Output JSON: [{"label": "...", "systemPromptSuffix": "..."}]`;

    try {
      const response = await this.gateway.complete({
        modelSlug,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1000,
      });

      // Try to parse JSON from the response
      const match = response.content.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as unknown;
        if (
          Array.isArray(parsed) &&
          parsed.length === n &&
          parsed.every(
            (p): p is SwarmPerspective =>
              typeof p === "object" &&
              p !== null &&
              typeof (p as Record<string, unknown>).label === "string" &&
              typeof (p as Record<string, unknown>).systemPromptSuffix === "string",
          )
        ) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn(`[swarm] Failed to auto-generate perspectives: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Fallback: generic labels
    return Array.from({ length: n }, (_, i) => ({
      label: `Perspective ${i + 1}`,
      systemPromptSuffix: `Analyze this from perspective ${i + 1} of ${n}, focusing on a unique angle.`,
    }));
  }

  /**
   * custom: all clones get full input; each gets its own explicit system prompt.
   */
  private buildCustomInputs(
    swarm: SwarmConfig,
    input: string,
  ): CloneInput[] {
    const prompts = swarm.customClonePrompts ?? [];
    return prompts.map((prompt) => ({
      input,
      systemPromptOverride: prompt,
      userPromptPortion: prompt,
    }));
  }

  // ─── runClone ─────────────────────────────────────────────────────────────

  private async runClone(
    stage: PipelineStageConfig,
    cloneInput: CloneInput,
    context: StageContext,
    stageId: string,
    cloneIndex: number,
  ): Promise<SwarmCloneResult> {
    const systemPromptPreview = cloneInput.userPromptPortion.slice(0, 120);
    const runId = context.runId;

    this.broadcast(runId, stageId, "swarm:clone:started", {
      cloneIndex,
      systemPromptPreview,
    });

    const start = Date.now();

    try {
      const team = this.teamRegistry.getTeam(stage.teamId);
      const cloneContext: StageContext = {
        ...context,
        stageConfig: {
          ...stage,
          systemPromptOverride: cloneInput.systemPromptOverride,
        },
      };

      const result = await team.execute(
        { taskDescription: cloneInput.input },
        cloneContext,
        stage.executionStrategy,
      );

      const durationMs = Date.now() - start;
      const outputStr =
        typeof result.output.raw === "string"
          ? result.output.raw
          : JSON.stringify(result.output);

      this.broadcast(runId, stageId, "swarm:clone:completed", {
        cloneIndex,
        tokensUsed: result.tokensUsed,
        outputPreview: outputStr.slice(0, 200),
      });

      return {
        cloneIndex,
        status: "succeeded",
        output: outputStr,
        tokensUsed: result.tokensUsed,
        durationMs,
        systemPromptPreview,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.broadcast(runId, stageId, "swarm:clone:failed", {
        cloneIndex,
        error: errorMsg,
      });

      // Return failed result — do NOT throw — partial failure is allowed
      return {
        cloneIndex,
        status: "failed",
        error: errorMsg,
        tokensUsed: 0,
        durationMs,
        systemPromptPreview,
      };
    }
  }

  // ─── runClonesWithConcurrency ──────────────────────────────────────────────

  private async runClonesWithConcurrency(
    cloneInputs: CloneInput[],
    stage: PipelineStageConfig,
    context: StageContext,
    stageId: string,
    maxConcurrent: number,
  ): Promise<SwarmCloneResult[]> {
    const results: SwarmCloneResult[] = new Array(cloneInputs.length);
    const queue = cloneInputs.map((input, i) => ({ input, i }));

    const runWorker = async (): Promise<void> => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        results[item.i] = await this.runClone(stage, item.input, context, stageId, item.i);
      }
    };

    const workers = Array.from(
      { length: Math.min(maxConcurrent, cloneInputs.length) },
      () => runWorker(),
    );
    await Promise.all(workers);
    return results;
  }

  // ─── mergeOutputs ─────────────────────────────────────────────────────────

  private async mergeOutputs(
    swarm: SwarmConfig,
    succeeded: Array<SwarmCloneResult & { status: "succeeded" }>,
    stage: PipelineStageConfig,
  ): Promise<string> {
    switch (swarm.merger) {
      case "concatenate":
        return this.mergeConcatenate(succeeded);
      case "llm_merge":
        return this.mergeLlm(swarm, succeeded, stage);
      case "vote":
        return this.mergeVote(swarm, succeeded, stage);
    }
  }

  /**
   * concatenate: join outputs with section headers.
   */
  private mergeConcatenate(
    succeeded: Array<SwarmCloneResult & { status: "succeeded" }>,
  ): string {
    return succeeded
      .map((r) => `## Clone ${r.cloneIndex + 1}\n\n${r.output ?? ""}`)
      .join("\n\n---\n\n");
  }

  /**
   * llm_merge: synthesize all outputs into one coherent result via LLM.
   */
  private async mergeLlm(
    swarm: SwarmConfig,
    succeeded: Array<SwarmCloneResult & { status: "succeeded" }>,
    stage: PipelineStageConfig,
  ): Promise<string> {
    const modelSlug = swarm.mergerModelSlug ?? stage.modelSlug;
    const outputsFormatted = succeeded
      .map((r, i) => `Output ${i + 1} (Clone ${r.cloneIndex + 1}):\n${r.output ?? ""}`)
      .join("\n\n");

    const prompt = `You are merging ${succeeded.length} parallel analyses into one coherent result. Outputs:\n\n${outputsFormatted}\n\nProduce a unified synthesis.`;

    const response = await this.gateway.complete({
      modelSlug,
      messages: [{ role: "user", content: prompt }],
    });

    return response.content;
  }

  /**
   * vote: attempt to parse each output as structured JSON with a `result` field.
   * If parseable: majority wins; ties fall back to llm_merge.
   * If not parseable: fall back to concatenate with a warning.
   */
  private async mergeVote(
    swarm: SwarmConfig,
    succeeded: Array<SwarmCloneResult & { status: "succeeded" }>,
    stage: PipelineStageConfig,
  ): Promise<string> {
    type ParsedValue = boolean | number | string;

    const parseResult = (output: string | undefined): ParsedValue | null => {
      if (!output) return null;
      try {
        const parsed = JSON.parse(output) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "result" in parsed
        ) {
          const val = (parsed as Record<string, unknown>).result;
          if (typeof val === "boolean" || typeof val === "number" || typeof val === "string") {
            return val;
          }
        }
      } catch {
        // Not JSON — try parsing the entire output as a single token
        const trimmed = output.trim();
        if (trimmed === "true") return true;
        if (trimmed === "false") return false;
        const num = Number(trimmed);
        if (!isNaN(num) && trimmed.length > 0) return num;
        // Single-word category
        if (/^\w+$/.test(trimmed)) return trimmed;
      }
      return null;
    };

    const parsedValues = succeeded.map((r) => parseResult(r.output));
    const allParseable = parsedValues.every((v) => v !== null);

    if (!allParseable) {
      console.warn(`[swarm] vote merger: outputs are not structured — falling back to concatenate`);
      return this.mergeConcatenate(succeeded);
    }

    // Count votes
    const voteCounts = new Map<string, number>();
    for (const val of parsedValues) {
      const key = String(val);
      voteCounts.set(key, (voteCounts.get(key) ?? 0) + 1);
    }

    const maxVotes = Math.max(...voteCounts.values());
    const winners = [...voteCounts.entries()]
      .filter(([, count]) => count === maxVotes)
      .map(([key]) => key);

    // Tie: fall back to llm_merge
    if (winners.length > 1) {
      return this.mergeLlm(swarm, succeeded, stage);
    }

    const winner = winners[0];
    return JSON.stringify({ result: winner });
  }

  // ─── WS broadcast helper ──────────────────────────────────────────────────

  private broadcast(
    runId: string,
    stageId: string,
    type:
      | "swarm:started"
      | "swarm:clone:started"
      | "swarm:clone:completed"
      | "swarm:clone:failed"
      | "swarm:merging"
      | "swarm:completed",
    payload: Record<string, unknown>,
  ): void {
    this.wsManager.broadcastToRun(runId, {
      type,
      runId,
      payload: { stageId, ...payload },
      timestamp: new Date().toISOString(),
    });
  }
}
