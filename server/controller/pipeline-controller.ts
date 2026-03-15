import type { IStorage } from "../storage";
import type { TeamRegistry } from "../teams/registry";
import type { WsManager } from "../ws/manager";
import type { PipelineStageConfig, WsEvent, SandboxFile, StageOutput } from "@shared/types";
import type { PipelineRun } from "@shared/schema";
import { SandboxExecutor } from "../sandbox/executor";

export class PipelineController {
  private activeRuns: Map<string, AbortController> = new Map();
  private sandboxExecutor: SandboxExecutor;

  constructor(
    private storage: IStorage,
    private teamRegistry: TeamRegistry,
    private wsManager: WsManager,
  ) {
    this.sandboxExecutor = new SandboxExecutor();
  }

  async startRun(pipelineId: string, input: string): Promise<PipelineRun> {
    const pipeline = await this.storage.getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);

    const stages = pipeline.stages as PipelineStageConfig[];

    const run = await this.storage.createPipelineRun({
      pipelineId,
      status: "running",
      input,
      currentStageIndex: 0,
      startedAt: new Date(),
    });

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

    this.broadcast(run.id, {
      type: "pipeline:started",
      runId: run.id,
      payload: {
        pipelineId,
        input,
        totalStages: stages.filter((s) => s.enabled).length,
      },
      timestamp: new Date().toISOString(),
    });

    // Execute stages in background
    const abortController = new AbortController();
    this.activeRuns.set(run.id, abortController);
    this.executeStages(run, stages, abortController.signal).catch((err) => {
      console.error(`Pipeline run ${run.id} error:`, err);
    });

    return run;
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

        const context = {
          runId: run.id,
          stageIndex: i,
          modelSlug: stage.modelSlug,
          temperature: stage.temperature,
          maxTokens: stage.maxTokens,
          previousOutputs,
          fullContext,
          // Privacy: use the run ID as a stable sessionId for the full run
          privacySettings: stage.privacySettings?.enabled
            ? stage.privacySettings
            : undefined,
          sessionId: run.id,
        };

        // Pass execution strategy (undefined = single, handled in BaseTeam)
        const result = await team.execute(stageInput, context, stage.executionStrategy);

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

        // Stage completed
        await this.storage.updateStageExecution(stageExec.id, {
          status: "completed",
          output: result.output,
          tokensUsed: result.tokensUsed,
          completedAt: new Date(),
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
          },
          timestamp: new Date().toISOString(),
        });

        // Also send a chat message for the stage output
        await this.storage.createChatMessage({
          runId: run.id,
          role: "agent",
          agentTeam: stage.teamId,
          modelSlug: stage.modelSlug,
          content: result.output.summary as string ?? `${stage.teamId} stage completed.`,
          metadata: { stageIndex: i, output: result.output },
        });
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

        this.activeRuns.delete(run.id);
        return;
      }
    }

    // All stages complete
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
}
