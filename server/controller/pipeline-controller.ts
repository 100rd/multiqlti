import type { IStorage } from "../storage";
import type { TeamRegistry } from "../teams/registry";
import type { WsManager } from "../ws/manager";
import type { Gateway } from "../gateway/index";
import type { PipelineStageConfig, WsEvent, SandboxFile, StageOutput, DelegationRequest, DelegateFn, PipelineDAG, DAGStage, SwarmResult } from "@shared/types";
import { DelegationService } from "../pipeline/delegation-service";
import { DAGExecutor } from "../pipeline/dag-executor";
import type { StageExecuteFn } from "../pipeline/dag-executor";
import { ParallelExecutor } from "../pipeline/parallel-executor";
import { SwarmExecutor } from "../pipeline/swarm-executor";
import type { PipelineRun } from "@shared/schema";
import { SandboxExecutor } from "../sandbox/executor";
import { ThoughtTreeCollector } from "../pipeline/thought-tree-collector";
import { MemoryExtractor } from "../memory/extractor";
import { MemoryProvider } from "../memory/provider";
import { ephemeralVarStore } from "../run-variables/store";
import { GuardrailValidator } from "../pipeline/guardrail-validator.js";
import { ManagerAgent } from "../pipeline/manager-agent";
import type { ManagerConfig } from "@shared/types";

interface ApprovalHandle {
  resolve: (approved: boolean) => void;
  reason?: string;
}

export class PipelineController {
  private activeRuns: Map<string, AbortController> = new Map();
  private pendingApprovals: Map<string, ApprovalHandle> = new Map();
  private sandboxExecutor: SandboxExecutor;
  private parallelExecutor: ParallelExecutor;
  private swarmExecutor: SwarmExecutor;
  private memoryExtractor: MemoryExtractor;
  private memoryProvider: MemoryProvider;
  private guardrailValidator: GuardrailValidator;
  private delegationService?: DelegationService;
  private dagExecutor: DAGExecutor;
  private managerAgent?: ManagerAgent;

  constructor(
    private storage: IStorage,
    private teamRegistry: TeamRegistry,
    private wsManager: WsManager,
    gateway?: Gateway,
    delegationService?: DelegationService,
    managerAgent?: ManagerAgent,
  ) {
    this.sandboxExecutor = new SandboxExecutor();
    this.parallelExecutor = new ParallelExecutor(
      gateway ?? createNullGateway(),
      teamRegistry,
      wsManager,
    );
    this.swarmExecutor = new SwarmExecutor(
      gateway ?? createNullGateway(),
      teamRegistry,
      wsManager,
    );
    this.memoryExtractor = new MemoryExtractor();
    this.memoryProvider = new MemoryProvider(storage);
    this.guardrailValidator = new GuardrailValidator(gateway ?? createNullGateway());
    this.delegationService = delegationService;
    this.managerAgent = managerAgent;
    this.dagExecutor = new DAGExecutor(storage, wsManager);
  }

  async startRun(pipelineId: string, input: string, variables?: Record<string, string>, triggeredBy?: string): Promise<PipelineRun> {
    const pipeline = await this.storage.getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);

    const dag = pipeline.dag as PipelineDAG | null | undefined;
    const stages = pipeline.stages as PipelineStageConfig[];

    const run = await this.storage.createPipelineRun({
      pipelineId,
      status: "running",
      input,
      currentStageIndex: 0,
      startedAt: new Date(),
      triggeredBy: triggeredBy ?? null,
      dagMode: dag != null,
    });

    this.broadcast(run.id, {
      type: "pipeline:started",
      runId: run.id,
      payload: {
        pipelineId,
        input,
        dagMode: dag != null,
        totalStages: dag ? dag.stages.filter((s) => s.enabled).length : stages.filter((s) => s.enabled).length,
      },
      timestamp: new Date().toISOString(),
    });

    // Store ephemeral variables in-memory (never written to DB)
    if (variables && Object.keys(variables).length > 0) {
      ephemeralVarStore.set(run.id, variables);
    }

    const abortController = new AbortController();
    this.activeRuns.set(run.id, abortController);

    const managerConfig = pipeline.managerConfig as ManagerConfig | null | undefined;
    if (managerConfig != null && this.managerAgent != null) {
      // ── Manager mode ──
      this.managerAgent
        .run(run.id, input, managerConfig, abortController.signal)
        .then(async ({ status }) => {
          const finalStatus = status === "completed" ? "completed" : "failed";
          await this.storage.updatePipelineRun(run.id, {
            status: finalStatus,
            completedAt: new Date(),
          });
          this.activeRuns.delete(run.id);
        })
        .catch(async (err) => {
          console.error(`Manager run ${run.id} error:`, err);
          await this.storage.updatePipelineRun(run.id, {
            status: "failed",
            output: String(err),
            completedAt: new Date(),
          });
          this.activeRuns.delete(run.id);
        });
      return run;
    }

    if (dag != null) {
      // ── DAG mode ──
      const executeStage = this.makeDAGStageExecuteFn(run);
      this.dagExecutor
        .executeDAG(run, dag, abortController.signal, executeStage)
        .then(() => this.finishDAGRun(run.id, abortController.signal))
        .catch((err) => {
          console.error(`DAG run ${run.id} error:`, err);
        });
    } else {
      // ── Linear mode ──
      // Create stage execution records for each enabled stage
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        await this.storage.createStageExecution({
          runId: run.id,
          stageIndex: i,
          teamId: stage.teamId,
          modelSlug: stage.modelSlug,
          status: stage.enabled ? "pending" : "skipped",
          input: {},
        });
      }
      this.executeStages(run, stages, abortController.signal).catch((err) => {
        console.error(`Pipeline run ${run.id} error:`, err);
      });
    }

    return run;
  }

  /**
   * Creates a StageExecuteFn bound to this controller for use by DAGExecutor.
   * The DAG executor calls this for each stage it wants to run.
   */
  private makeDAGStageExecuteFn(run: PipelineRun): StageExecuteFn {
    return async (
      _run: PipelineRun,
      dagStage: DAGStage,
      stageInput: Record<string, unknown>,
      stageIndex: number,
      dagStageId: string,
    ): Promise<{ output: Record<string, unknown>; failed: boolean }> => {
      const executions = await this.storage.getStageExecutions(run.id);
      const stageExec = executions.find((e) => e.dagStageId === dagStageId);
      if (!stageExec) {
        return { output: {}, failed: true };
      }

      await this.storage.updateStageExecution(stageExec.id, {
        status: "running",
        startedAt: new Date(),
        input: stageInput,
      });

      this.broadcast(run.id, {
        type: "stage:started",
        runId: run.id,
        stageExecutionId: stageExec.id,
        payload: {
          stageIndex,
          teamId: dagStage.teamId,
          modelSlug: dagStage.modelSlug,
          dagStageId,
        },
        timestamp: new Date().toISOString(),
      });

      try {
        const team = this.teamRegistry.getTeam(dagStage.teamId);
        const numericRunId = this.hashRunId(run.id);
        const numericPipelineId = this.hashRunId(run.pipelineId);

        const relevantMemories = await this.memoryProvider.getRelevantMemories({
          pipelineId: numericPipelineId,
          runId: numericRunId,
          teamId: dagStage.teamId,
          maxTokenBudget: 2000,
        });
        const memoryContext = relevantMemories.length > 0
          ? this.memoryProvider.formatForPrompt(relevantMemories)
          : undefined;

        const context = {
          runId: run.id,
          stageIndex,
          stageExecutionId: stageExec.id,
          modelSlug: dagStage.modelSlug,
          temperature: dagStage.temperature,
          maxTokens: dagStage.maxTokens,
          previousOutputs: [],
          fullContext: [] as StageOutput[],
          sessionId: run.id,
          memoryContext,
          variables: ephemeralVarStore.get(run.id) ?? undefined,
          stageConfig: dagStage as unknown as PipelineStageConfig,
        };

        const result = await team.execute(stageInput, context, dagStage.executionStrategy);

        const newMemories = await this.memoryExtractor.extractFromStageResult(
          dagStage.teamId,
          numericRunId,
          numericPipelineId,
          result.output ?? {},
        );
        await Promise.all(newMemories.map((m) => this.storage.upsertMemory(m)));

        await this.storage.updateStageExecution(stageExec.id, {
          status: "completed",
          output: result.output,
          tokensUsed: result.tokensUsed,
          completedAt: new Date(),
        });

        this.broadcast(run.id, {
          type: "stage:completed",
          runId: run.id,
          stageExecutionId: stageExec.id,
          payload: {
            stageIndex,
            teamId: dagStage.teamId,
            dagStageId,
            output: result.output,
            tokensUsed: result.tokensUsed,
          },
          timestamp: new Date().toISOString(),
        });

        return { output: result.output, failed: false };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : "Unknown error";

        await this.storage.updateStageExecution(stageExec.id, {
          status: "failed",
          completedAt: new Date(),
        });

        this.broadcast(run.id, {
          type: "stage:failed",
          runId: run.id,
          stageExecutionId: stageExec.id,
          payload: { error: errMsg, stageIndex, dagStageId },
          timestamp: new Date().toISOString(),
        });

        return { output: {}, failed: true };
      }
    };
  }

  /** Called after DAGExecutor finishes to mark run as completed or failed. */
  private async finishDAGRun(runId: string, signal: AbortSignal): Promise<void> {
    const executions = await this.storage.getStageExecutions(runId);
    const anyFailed = executions.some((e) => e.status === "failed");

    if (signal.aborted) {
      this.activeRuns.delete(runId);
      return;
    }

    if (anyFailed) {
      await this.storage.updatePipelineRun(runId, {
        status: "failed",
        completedAt: new Date(),
      });
      this.broadcast(runId, {
        type: "pipeline:failed",
        runId,
        payload: { error: "One or more DAG stages failed" },
        timestamp: new Date().toISOString(),
      });
    } else {
      await this.storage.updatePipelineRun(runId, {
        status: "completed",
        completedAt: new Date(),
      });
      this.broadcast(runId, {
        type: "pipeline:completed",
        runId,
        payload: {},
        timestamp: new Date().toISOString(),
      });
    }

    ephemeralVarStore.clearOnSuccess(runId);
    this.activeRuns.delete(runId);
  }

  private extractFilesFromOutput(output: Record<string, unknown>): SandboxFile[] {
    const files: SandboxFile[] = [];

    // Check structured output.files array first
    const rawFiles = output.files as Array<{ path: string; content: string }> | undefined;
    if (Array.isArray(rawFiles)) {
      for (const f of rawFiles) {
        if (f.path && f.content) {
          files.push({ path: f.path, content: f.content });
        }
      }
      return files;
    }

    // Parse markdown code blocks from string fields
    const raw = (output.raw as string) ?? JSON.stringify(output);
    const patterns = [
      /```\w*\s+\/\/\s*filename:\s*(\S+)\n([\s\S]*?)```/g,
      /```\w*\s+(\S+\.\w+)\n([\s\S]*?)```/g,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(raw)) !== null) {
        const path = match[1];
        const content = match[2];
        if (path && content && !files.find((f) => f.path === path)) {
          files.push({ path, content });
        }
      }
    }

    return files;
  }

  /** Returns a promise that resolves to true (approved) or false (rejected). */
  private waitForApproval(approvalKey: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(approvalKey, { resolve });
    });
  }

  private makeApprovalKey(runId: string, stageIndex: number): string {
    return `${runId}::${stageIndex}`;
  }

  async approveStage(runId: string, stageIndex: number, approvedBy?: string): Promise<void> {
    const key = this.makeApprovalKey(runId, stageIndex);
    const handle = this.pendingApprovals.get(key);
    if (!handle) throw new Error(`No pending approval for run ${runId} stage ${stageIndex}`);

    this.pendingApprovals.delete(key);

    // Update DB
    const executions = await this.storage.getStageExecutions(runId);
    const stageExec = executions.find((e) => e.stageIndex === stageIndex);
    if (stageExec) {
      await this.storage.updateStageExecution(stageExec.id, {
        approvalStatus: "approved",
        approvedAt: new Date(),
        approvedBy: approvedBy ?? null,
      });
    }

    // Update run back to running
    await this.storage.updatePipelineRun(runId, { status: "running" });

    this.broadcast(runId, {
      type: "stage:approved",
      runId,
      payload: { stageIndex, approvedBy: approvedBy ?? null },
      timestamp: new Date().toISOString(),
    });

    handle.resolve(true);
  }

  async rejectStage(runId: string, stageIndex: number, reason?: string): Promise<void> {
    const key = this.makeApprovalKey(runId, stageIndex);
    const handle = this.pendingApprovals.get(key);
    if (!handle) throw new Error(`No pending approval for run ${runId} stage ${stageIndex}`);

    this.pendingApprovals.delete(key);

    // Update DB
    const executions = await this.storage.getStageExecutions(runId);
    const stageExec = executions.find((e) => e.stageIndex === stageIndex);
    if (stageExec) {
      await this.storage.updateStageExecution(stageExec.id, {
        approvalStatus: "rejected",
        rejectionReason: reason ?? null,
      });
    }

    await this.storage.updatePipelineRun(runId, {
      status: "rejected",
      completedAt: new Date(),
    });

    this.broadcast(runId, {
      type: "stage:rejected",
      runId,
      payload: { stageIndex, reason: reason ?? null },
      timestamp: new Date().toISOString(),
    });

    handle.resolve(false);
  }

  private async executeStages(
    run: PipelineRun,
    stages: PipelineStageConfig[],
    signal: AbortSignal,
    startFromIndex = 0,
  ): Promise<void> {
    const previousOutputs: Record<string, unknown>[] = [];
    const fullContext: StageOutput[] = [];

    // Collect outputs from already-completed stages (for resume)
    if (startFromIndex > 0) {
      const executions = await this.storage.getStageExecutions(run.id);
      for (let i = 0; i < startFromIndex; i++) {
        const exec = executions.find((e) => e.stageIndex === i);
        const output = (exec?.output as Record<string, unknown>) ?? {};
        previousOutputs.push(output);
        fullContext.push({ teamId: stages[i]?.teamId ?? "", output, stageIndex: i });
      }
    }

    // Numeric run id for memory operations (hash the UUID string to a stable int)
    const numericRunId = this.hashRunId(run.id);
    const numericPipelineId = this.hashRunId(run.pipelineId);

    for (let i = startFromIndex; i < stages.length; i++) {
      if (signal.aborted) return;

      const stage = stages[i];
      if (!stage.enabled) {
        previousOutputs.push({});
        fullContext.push({ teamId: stage.teamId, output: {}, stageIndex: i });
        continue;
      }

      // Find the stage execution record
      const executions = await this.storage.getStageExecutions(run.id);
      const stageExec = executions.find((e) => e.stageIndex === i);
      if (!stageExec) continue;

      // Update stage status to running
      await this.storage.updateStageExecution(stageExec.id, {
        status: "running",
        startedAt: new Date(),
      });
      await this.storage.updatePipelineRun(run.id, {
        currentStageIndex: i,
      });

      this.broadcast(run.id, {
        type: "stage:started",
        runId: run.id,
        stageExecutionId: stageExec.id,
        payload: {
          stageIndex: i,
          teamId: stage.teamId,
          modelSlug: stage.modelSlug,
          executionStrategy: stage.executionStrategy?.type ?? "single",
        },
        timestamp: new Date().toISOString(),
      });

      try {
        const team = this.teamRegistry.getTeam(stage.teamId);

        // Build input: first stage gets task description, others get previous output
        const stageInput =
          i === 0
            ? { taskDescription: run.input }
            : previousOutputs[i - 1] ?? {};

        // Update stage execution input
        await this.storage.updateStageExecution(stageExec.id, {
          input: stageInput,
        });

        // Fetch relevant memories before execution
        const relevantMemories = await this.memoryProvider.getRelevantMemories({
          pipelineId: numericPipelineId,
          runId: numericRunId,
          teamId: stage.teamId,
          maxTokenBudget: 2000,
        });
        const memoryContext = relevantMemories.length > 0
          ? this.memoryProvider.formatForPrompt(relevantMemories)
          : undefined;

        // Apply skill settings (if a skill is assigned to this stage)
        const resolvedStage = await this.applySkill(stage);

        const context = {
          runId: run.id,
          stageIndex: i,
          stageExecutionId: stageExec.id,
          modelSlug: resolvedStage.modelSlug,
          temperature: resolvedStage.temperature,
          maxTokens: resolvedStage.maxTokens,
          previousOutputs,
          fullContext,
          // Privacy: use the run ID as a stable sessionId for the full run
          privacySettings: resolvedStage.privacySettings?.enabled
            ? resolvedStage.privacySettings
            : undefined,
          sessionId: run.id,
          memoryContext,
          // Ephemeral run variables (in-memory only, never persisted)
          variables: ephemeralVarStore.get(run.id) ?? undefined,
          stageConfig: resolvedStage,
          delegate: this.buildDelegateFn(run.id, stage.teamId, resolvedStage),
        };

        // Pass execution strategy (undefined = single, handled in BaseTeam)
        // Swarm takes priority over parallel; falls back to single-agent if neither enabled
        let result;

        const stageInputStr = typeof stageInput === 'string'
          ? stageInput
          : (stageInput as Record<string, unknown>).taskDescription as string ?? JSON.stringify(stageInput);

        if (resolvedStage.swarm?.enabled) {
          if (resolvedStage.parallel?.enabled) {
            console.warn();
          }
          const swarmResult = await this.swarmExecutor.execute(
            resolvedStage,
            stageInputStr,
            context,
            stageExec.id,
          );
          if (swarmResult !== null) {
            await this.persistSwarmResults(stageExec.id, swarmResult);
            result = {
              output: { raw: swarmResult.mergedOutput, swarmMeta: swarmResult },
              tokensUsed: swarmResult.totalTokensUsed,
              raw: swarmResult.mergedOutput,
              questions: undefined,
              strategyResult: undefined,
              toolCallLog: undefined,
            };
          } else {
            result = await team.execute(stageInput, context, resolvedStage.executionStrategy);
          }
        } else {
          const parallelResult = await this.parallelExecutor.executeParallel(
            resolvedStage,
            stageInput,
            context,
            stageExec.id,
          );
          result = parallelResult !== null
            ? {
                output: parallelResult.output,
                tokensUsed: parallelResult.tokensUsed,
                raw: parallelResult.raw,
                questions: undefined,
                strategyResult: undefined,
                toolCallLog: undefined,
              }
            : await team.execute(stageInput, context, resolvedStage.executionStrategy);
        }

        // Collect thought tree from stage output
        const collector = new ThoughtTreeCollector();
        const rawOutput = result.output.raw as string | undefined;
        if (rawOutput) {
          collector.addFromLlmResponse(rawOutput, stage.modelSlug);
        } else if (typeof result.output.summary === "string") {
          collector.addFromLlmResponse(result.output.summary as string, stage.modelSlug);
        }
        const thoughtTree = collector.getTree();

        // Extract and persist memories from stage output
        const newMemories = await this.memoryExtractor.extractFromStageResult(
          stage.teamId,
          numericRunId,
          numericPipelineId,
          result.output ?? {},
        );
        await Promise.all(newMemories.map((m) => this.storage.upsertMemory(m)));

        // Check if team needs clarification
        if (result.questions && result.questions.length > 0) {
          for (const q of result.questions) {
            const question = await this.storage.createQuestion({
              runId: run.id,
              stageExecutionId: stageExec.id,
              question: q,
              context: `Stage: ${stage.teamId}`,
              status: "pending",
            });

            this.broadcast(run.id, {
              type: "question:asked",
              runId: run.id,
              payload: {
                questionId: question.id,
                question: q,
                context: `Stage: ${stage.teamId}`,
                stageExecutionId: stageExec.id,
              },
              timestamp: new Date().toISOString(),
            });
          }

          // Pause the run
          await this.storage.updateStageExecution(stageExec.id, {
            status: "paused",
          });
          await this.storage.updatePipelineRun(run.id, {
            status: "paused",
          });
          return; // Stop; resumeRun will re-enter
        }

        // ─── Sandbox Execution ────────────────────────────────────────────────
        let sandboxResult = null;

        if (stage.sandbox?.enabled) {
          const files = this.extractFilesFromOutput(result.output);

          this.broadcast(run.id, {
            type: "sandbox:starting",
            runId: run.id,
            stageExecutionId: stageExec.id,
            payload: {
              stageIndex: i,
              image: stage.sandbox.image,
              command: stage.sandbox.command,
            },
            timestamp: new Date().toISOString(),
          });

          sandboxResult = await this.sandboxExecutor.execute(
            stage.sandbox,
            files,
            (stream, data) => {
              this.broadcast(run.id, {
                type: "sandbox:output",
                runId: run.id,
                stageExecutionId: stageExec.id,
                payload: { stageIndex: i, stream, data },
                timestamp: new Date().toISOString(),
              });
            },
          );

          this.broadcast(run.id, {
            type: "sandbox:completed",
            runId: run.id,
            stageExecutionId: stageExec.id,
            payload: {
              stageIndex: i,
              exitCode: sandboxResult.exitCode,
              durationMs: sandboxResult.durationMs,
              timedOut: sandboxResult.timedOut,
            },
            timestamp: new Date().toISOString(),
          });

          result.output.sandboxResult = sandboxResult;

          if (stage.sandbox.failOnNonZero !== false && sandboxResult.exitCode !== 0) {
            throw new Error(
              `Sandbox failed (exit ${sandboxResult.exitCode}): ${sandboxResult.stderr.slice(0, 500)}`,
            );
          }
        }

        // Stage completed — persist thought tree alongside output
        await this.storage.updateStageExecution(stageExec.id, {
          status: "completed",
          output: result.output,
          tokensUsed: result.tokensUsed,
          completedAt: new Date(),
          thoughtTree: thoughtTree.length > 0 ? (thoughtTree as unknown as Record<string, unknown>[]) : null,
          ...(sandboxResult ? { sandboxResult } : {}),
        });

        previousOutputs.push(result.output);
        fullContext.push({ teamId: stage.teamId, output: result.output, stageIndex: i });

        this.broadcast(run.id, {
          type: "stage:completed",
          runId: run.id,
          stageExecutionId: stageExec.id,
          payload: {
            stageIndex: i,
            teamId: stage.teamId,
            output: result.output,
            tokensUsed: result.tokensUsed,
            strategyResult: result.strategyResult ?? null,
            memoriesUsed: relevantMemories.length,
          },
          timestamp: new Date().toISOString(),
        });

        // Broadcast thought tree if present
        if (thoughtTree.length > 0) {
          this.broadcast(run.id, {
            type: "stage:thought_tree",
            runId: run.id,
            stageExecutionId: stageExec.id,
            payload: { stageIndex: i, nodes: thoughtTree },
            timestamp: new Date().toISOString(),
          });
        }

        // Also send a chat message for the stage output
        await this.storage.createChatMessage({
          runId: run.id,
          role: "agent",
          agentTeam: stage.teamId,
          modelSlug: stage.modelSlug,
          content: result.output.summary as string ?? `${stage.teamId} stage completed.`,
          metadata: { stageIndex: i, output: result.output },
        });

        // ─── Approval Gate ────────────────────────────────────────────────────
        if (stage.approvalRequired) {
          const approvalKey = this.makeApprovalKey(run.id, i);

          await this.storage.updateStageExecution(stageExec.id, {
            status: "awaiting_approval",
            approvalStatus: "pending",
          });
          await this.storage.updatePipelineRun(run.id, { status: "paused" });

          this.broadcast(run.id, {
            type: "stage:awaiting_approval",
            runId: run.id,
            stageExecutionId: stageExec.id,
            payload: { stageIndex: i, teamId: stage.teamId },
            timestamp: new Date().toISOString(),
          });

          if (signal.aborted) return;

          const approved = await this.waitForApproval(approvalKey);

          if (!approved) {
            // run status already set to rejected in rejectStage()
            this.activeRuns.delete(run.id);
            return;
          }

          // Continue — restore stage status to completed
          await this.storage.updateStageExecution(stageExec.id, {
            status: "completed",
          });
        }
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Unknown error";

        await this.storage.updateStageExecution(stageExec.id, {
          status: "failed",
          completedAt: new Date(),
        });
        await this.storage.updatePipelineRun(run.id, {
          status: "failed",
          completedAt: new Date(),
        });

        this.broadcast(run.id, {
          type: "stage:failed",
          runId: run.id,
          stageExecutionId: stageExec.id,
          payload: { error: errMsg, stageIndex: i },
          timestamp: new Date().toISOString(),
        });
        this.broadcast(run.id, {
          type: "pipeline:failed",
          runId: run.id,
          payload: { error: errMsg, failedStageIndex: i },
          timestamp: new Date().toISOString(),
        });

        ephemeralVarStore.preserveOnFailure(run.id, `run failed at stage: ${stage.teamId}`);
        this.activeRuns.delete(run.id);
        return;
      }
    }

    // All stages complete — decay unconfirmed memories
    await this.memoryProvider.decayUnconfirmedMemories(numericRunId);

    const allOutputs = previousOutputs;
    await this.storage.updatePipelineRun(run.id, {
      status: "completed",
      output: allOutputs,
      completedAt: new Date(),
    });

    this.broadcast(run.id, {
      type: "pipeline:completed",
      runId: run.id,
      payload: { output: allOutputs },
      timestamp: new Date().toISOString(),
    });

    // Clear ephemeral variables on success — no trace left in memory
    ephemeralVarStore.clearOnSuccess(run.id);
    this.activeRuns.delete(run.id);
  }

  async resumeRun(runId: string): Promise<void> {
    const run = await this.storage.getPipelineRun(runId);
    if (!run || run.status !== "paused") return;

    const pipeline = await this.storage.getPipeline(run.pipelineId);
    if (!pipeline) return;

    const stages = pipeline.stages as PipelineStageConfig[];

    // Update run status
    await this.storage.updatePipelineRun(runId, { status: "running" });

    // Find the paused stage
    const executions = await this.storage.getStageExecutions(runId);
    const pausedStage = executions.find((e) => e.status === "paused");
    if (!pausedStage) return;

    // Update paused stage to running again
    await this.storage.updateStageExecution(pausedStage.id, {
      status: "pending",
    });

    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);

    this.executeStages(
      run,
      stages,
      abortController.signal,
      pausedStage.stageIndex,
    ).catch((err) => {
      console.error(`Pipeline resume ${runId} error:`, err);
    });
  }

  async cancelRun(runId: string): Promise<void> {
    const abort = this.activeRuns.get(runId);
    if (abort) {
      abort.abort();
      this.activeRuns.delete(runId);
    }

    // Resolve any pending approval as rejected to unblock the promise
    for (const [key, handle] of this.pendingApprovals) {
      if (key.startsWith(`${runId}::`)) {
        this.pendingApprovals.delete(key);
        handle.resolve(false);
      }
    }

    await this.storage.updatePipelineRun(runId, {
      status: "cancelled",
      completedAt: new Date(),
    });

    this.broadcast(runId, {
      type: "pipeline:cancelled",
      runId,
      payload: {},
      timestamp: new Date().toISOString(),
    });
  }

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    const question = await this.storage.answerQuestion(questionId, answer);

    this.broadcast(question.runId, {
      type: "question:answered",
      runId: question.runId,
      payload: { questionId, answer },
      timestamp: new Date().toISOString(),
    });

    // Check if all questions for this run are answered
    const pending = await this.storage.getPendingQuestions(question.runId);
    if (pending.length === 0) {
      await this.resumeRun(question.runId);
    }
  }

  async dismissQuestion(questionId: string): Promise<void> {
    const question = await this.storage.dismissQuestion(questionId);

    // Check if all questions for this run are answered/dismissed
    const pending = await this.storage.getPendingQuestions(question.runId);
    if (pending.length === 0) {
      await this.resumeRun(question.runId);
    }
  }

  isRunActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  private broadcast(runId: string, event: WsEvent): void {
    this.wsManager.broadcastToRun(runId, event);
  }

  private buildDelegateFn(
    runId: string,
    fromStage: string,
    stage: PipelineStageConfig,
  ): DelegateFn | undefined {
    if (!this.delegationService) return undefined;
    if (!stage.delegationEnabled) return undefined;
    return (request: DelegationRequest) =>
      this.delegationService!.delegate(runId, request, [fromStage]);
  }

  /**
   * If the stage has a skillId, load that skill and merge its settings into
   * the stage config (skill values act as fallbacks — explicit stage settings win).
   */
  private async applySkill(stage: PipelineStageConfig): Promise<PipelineStageConfig> {
    if (!stage.skillId) return stage;

    const skill = await this.storage.getSkill(stage.skillId);
    if (!skill) return stage;

    return {
      ...stage,
      modelSlug: stage.modelSlug || skill.modelPreference || stage.modelSlug,
      systemPromptOverride: stage.systemPromptOverride
        ? `${skill.systemPromptOverride}

${stage.systemPromptOverride}`
        : skill.systemPromptOverride || stage.systemPromptOverride,
      tools: stage.tools
        ? {
            ...stage.tools,
            enabled: true,
            allowedTools: [
              ...new Set([
                ...(stage.tools.allowedTools ?? []),
                ...(skill.tools as string[]),
              ]),
            ],
          }
        : (skill.tools as string[]).length > 0
          ? { enabled: true, allowedTools: skill.tools as string[] }
          : undefined,
    };
  }

  /**
   * Converts a UUID string to a stable 32-bit integer for use as memory run/pipeline IDs.
   * Uses the first 8 hex chars of the UUID (32-bit prefix).
   */
  private hashRunId(id: string): number {
    const hex = id.replace(/-/g, "").slice(0, 8);
    return parseInt(hex, 16) || 0;
  }

  /**
   * Persist swarm clone results and metadata to the stageExecution DB row.
   */
  private async persistSwarmResults(
    stageExecutionId: string,
    result: SwarmResult,
  ): Promise<void> {
    await this.storage.updateStageExecution(stageExecutionId, {
      swarmCloneResults: result.cloneResults,
      swarmMeta: {
        cloneCount: result.cloneResults.length,
        succeededCount: result.succeededCount,
        failedCount: result.failedCount,
        mergerUsed: result.mergerUsed,
        splitterUsed: result.splitterUsed,
        totalTokensUsed: result.totalTokensUsed,
        durationMs: result.durationMs,
      },
    } as Parameters<typeof this.storage.updateStageExecution>[1]);
  }
}

function createNullGateway(): Gateway {
  return {
    complete: async () => ({ content: "", tokensUsed: 0, modelSlug: "null", finishReason: "stop" }),
    stream: async function* () { yield ""; },
    completeWithTools: async () => ({ content: "", tokensUsed: 0, modelSlug: "null", finishReason: "stop", toolCalls: [] }),
  } as unknown as Gateway;
}
