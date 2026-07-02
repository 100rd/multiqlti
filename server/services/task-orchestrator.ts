import type { IStorage } from "../storage";
import type { WsManager } from "../ws/manager";
import type { PipelineController } from "../controller/pipeline-controller";
import type { Gateway } from "../gateway/index";
import type {
  TaskGroupRow,
  TaskRow,
  InsertTaskGroup,
  InsertTask,
  TaskGroupIterationRow,
  TaskExecutionRow,
} from "@shared/schema";
import type {
  WsEvent,
  TaskResult,
  GatewayRequest,
  GatewayResponse,
  StreamingStageOptions,
} from "@shared/types";
import type { TaskTracer } from "./task-tracer";
import { configLoader } from "../config/loader.js";
import { DEFAULT_TASK_MODEL } from "../config/schema.js";
import type { IterationExecutionSeed } from "../storage-task-groups-v2.js";
import type { VisibilityUser } from "../routes/authorize-run";
import { composeTemplateFields } from "./task-template-compose.js";
import { validateTaskGraph } from "./task-graph.js";
import { ExecutionClaims } from "./orchestrator/execution-claims.js";
import { IterationTracing } from "./orchestrator/iteration-tracing.js";
import {
  RunActiveError,
  IterationCapError,
  NoReadyTasksError,
  MissingPipelineError,
  InvalidTaskGraphError,
} from "./orchestrator/errors.js";
import {
  collectDepOutputs,
  buildSystemPrompt,
  parseDirectLlmResponse,
} from "./orchestrator/direct-llm-prompt.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CONCURRENT_TASKS = 5;
const PIPELINE_POLL_INTERVAL_MS = 2000;
const PIPELINE_POLL_TIMEOUT_MS = 600_000; // 10 min

// ─── Errors ───────────────────────────────────────────────────────────────────

// Extracted to ./orchestrator/errors.ts (L3). Re-exported here so existing
// import paths (routes, tests) are unchanged.
export {
  RunActiveError,
  IterationCapError,
  NoReadyTasksError,
  MissingPipelineError,
  InvalidTaskGraphError,
} from "./orchestrator/errors.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** One task in a create payload — manual, or COPY-IN from a library template. */
export interface CreateTaskParam {
  name: string;
  description: string;
  executionMode?: "pipeline_run" | "direct_llm";
  dependsOn?: string[]; // task names within this group
  pipelineId?: string;
  modelSlug?: string;
  teamId?: string;
  input?: Record<string, unknown>;
  sortOrder?: number;
  /**
   * Optional workspace the task's pipeline_run runs are recorded against (§14.3).
   * Additive: omitted/undefined = today's behaviour (no workspace on startRun).
   */
  workspaceId?: string;
  /** When set, copy the template's fields into this definition (§5.3/§6 COPY-IN). */
  templateId?: string;
}

export interface CreateTaskGroupParams {
  name: string;
  description: string;
  input: string;
  tasks: CreateTaskParam[];
  createdBy?: string;
  /**
   * The authenticated caller, used to owner-check any composed template ONCE at
   * compose time (§6). Omitted only by tests that supply no `templateId`.
   */
  composeUser?: VisibilityUser;
}

export interface StartGroupOptions {
  triggeredBy?: string | null;
  /**
   * §14.5 non-blocking model. Default `true` = the historical behaviour:
   * `startGroup` awaits the whole batch and returns the SETTLED group/iteration.
   * When `false` (the consilium loop path via `startGroupAsync`), the iteration
   * row + executions are created and the group marked `running` SYNCHRONOUSLY,
   * `launchBatch` is dispatched fire-and-forget, and the freshly-created
   * `{group, iteration}` is returned IMMEDIATELY. A background batch rejection is
   * caught and fails the iteration/group (never a perpetual `running`).
   */
  await?: boolean;
}

/** The resolved fields a definition row is created with (template overlay applied). */
interface ResolvedTaskFields {
  executionMode: "pipeline_run" | "direct_llm";
  pipelineId: string | null;
  modelSlug: string | null;
  teamId: string | null;
  input: Record<string, unknown>;
  workspaceId: string | null;
  labels: string[];
  templateId: string | null;
}

// ─── Human-in-the-loop note carry-forward ───────────────────────────────────

/** Marker that opens the carried human-note block in an iteration's input. */
export const HUMAN_NOTE_HEADING = "## Решения и заметки человека (предыдущий раунд)";

/**
 * Fold the previous iteration's human note (if any) into the next iteration's
 * input snapshot. The note is appended under a clear heading so every debater /
 * judge sees the user's thoughts and decisions as part of the standing
 * objective. A blank/whitespace-only note is ignored (returns the base input).
 */
export function composeIterationInput(baseInput: string, humanNote: string | null): string {
  const note = (humanNote ?? "").trim();
  if (!note) return baseInput;
  return `${baseInput}\n\n${HUMAN_NOTE_HEADING}:\n${note}`;
}

// ─── Judge timeout resilience (fix: bounded retry with model fallback) ──────

/** Structured record of the single bounded retry, surfaced for observability. */
interface RetryNote {
  cause: "timeout" | "empty output";
  /** The fallback slug used, or null when the retry re-used the task's model. */
  fallbackModel: string | null;
  /** The slug the retry attempt actually ran under. */
  retriedModel: string;
}

/** A direct_llm gateway call that returned no usable content (0-token/empty). */
function isEmptyCompletion(response: GatewayResponse): boolean {
  return response.content.trim().length === 0;
}

/**
 * A gateway error that is a WALL-CLOCK TIMEOUT (the judge's cap on the largest-
 * context call), as opposed to a budget/auth/other failure. Matched by the
 * provider error name/message so it is cross-provider: the CLI providers throw
 * `CliOverallTimeoutError` / "CLI timed out after …" / "exceeded overall cap",
 * the API providers throw a `TimeoutError`. NON-timeout errors are NOT retried —
 * they propagate exactly as today.
 */
function isTimeoutError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  return /timeout/i.test(name) || /timed out|timeout|overall cap/i.test(message);
}

/**
 * Fold the retry note into the parsed result so an operator can SEE that the
 * judge/LLM call retried and under which model — additive `output._retry`
 * structured record + one human-readable `decisions[]` line. When there was no
 * retry the result is returned byte-identical (inert path).
 */
function annotateRetry(result: TaskResult, note: RetryNote | null): TaskResult {
  if (!note) return result;
  const label = note.fallbackModel
    ? `retried (fallback: ${note.fallbackModel})`
    : "retried (same model)";
  return {
    ...result,
    output: {
      ...(result.output ?? {}),
      _retry: {
        retried: true,
        cause: note.cause,
        model: note.retriedModel,
        fallbackModel: note.fallbackModel,
      },
    },
    decisions: [...(result.decisions ?? []), `judge/LLM call ${label} after ${note.cause}`],
  };
}

// ─── Task Orchestrator ──────────────────────────────────────────────────────

export class TaskOrchestrator {
  /** Tracer-binding glue (BE4) — owns the optional tracer + per-group spans. */
  private readonly tracing: IterationTracing;
  /**
   * The ids of groups currently in flight — tracked INDEPENDENTLY of the
   * optional tracer (M1). The tracing collaborator's context map is only
   * populated when a tracer is attached, so a tracer-less deployment would
   * otherwise report no running groups to /api/activity. This set is the source
   * of truth for liveness.
   */
  private readonly activeGroupIds = new Set<string>();
  /**
   * Per-iteration launch claims — guarantees each execution launches exactly
   * once even when two dependency completions race to unblock the same join
   * (C1). See ExecutionClaims for the atomicity contract.
   */
  private readonly claims = new ExecutionClaims();

  constructor(
    private storage: IStorage,
    private wsManager: WsManager,
    private pipelineController: PipelineController,
    private gateway: Gateway,
  ) {
    this.tracing = new IterationTracing(storage);
  }

  /** Attach a tracer instance (called during route registration). */
  setTracer(tracer: TaskTracer): void {
    this.tracing.setTracer(tracer);
  }

  /**
   * The ids of the task groups currently in flight (between startGroup and group
   * settle). Backed by the tracer-independent `activeGroupIds` set (M1), so the
   * live /api/activity snapshot is correct even with no tracer attached. Sibling
   * of the controllers' getActiveRunIds().
   */
  getActiveGroupIds(): string[] {
    return [...this.activeGroupIds];
  }

  /**
   * Resolve one create-payload task to its final definition fields. A `templateId`
   * triggers COPY-IN: the template is owner-checked ONCE here (§6) and its fields
   * are copied; explicit per-task fields override the template's where provided.
   */
  private async resolveTaskFields(
    t: CreateTaskParam,
    user: VisibilityUser | undefined,
  ): Promise<ResolvedTaskFields> {
    if (!t.templateId) {
      return {
        executionMode: t.executionMode ?? "direct_llm",
        pipelineId: t.pipelineId ?? null,
        modelSlug: t.modelSlug ?? null,
        teamId: t.teamId ?? null,
        input: t.input ?? {},
        workspaceId: t.workspaceId ?? null,
        labels: [],
        templateId: null,
      };
    }
    const tpl = await composeTemplateFields(this.storage, t.templateId, user);
    return {
      executionMode: t.executionMode ?? tpl.executionMode,
      pipelineId: t.pipelineId ?? tpl.pipelineId,
      modelSlug: t.modelSlug ?? tpl.modelSlug,
      teamId: t.teamId ?? tpl.teamId,
      input: t.input ?? tpl.input,
      workspaceId: t.workspaceId ?? null,
      labels: tpl.labels,
      templateId: tpl.templateId,
    };
  }

  /**
   * Create a task group with task DEFINITIONS. Resolves task name references in
   * dependsOn to IDs and computes initial DEFINITION statuses (ready / blocked).
   * Definitions are templates: each `start` creates a fresh iteration of them.
   * A task carrying `templateId` is COPIED-IN from the library (§5.3/§6).
   */
  async createTaskGroup(params: CreateTaskGroupParams): Promise<{ group: TaskGroupRow; tasks: TaskRow[] }> {
    const group = await this.storage.createTaskGroup({
      name: params.name,
      description: params.description,
      input: params.input,
      status: "pending",
      createdBy: params.createdBy ?? null,
    } as InsertTaskGroup);

    // First pass: create all tasks (template copy-in applied) with placeholder deps.
    const nameToId = new Map<string, string>();
    const createdTasks: TaskRow[] = [];

    for (let i = 0; i < params.tasks.length; i++) {
      const t = params.tasks[i];
      const fields = await this.resolveTaskFields(t, params.composeUser);
      const task = await this.storage.createTask({
        groupId: group.id,
        name: t.name,
        description: t.description,
        executionMode: fields.executionMode,
        dependsOn: [], // populated in second pass
        pipelineId: fields.pipelineId,
        workspaceId: fields.workspaceId,
        modelSlug: fields.modelSlug,
        teamId: fields.teamId,
        input: fields.input,
        labels: fields.labels,
        templateId: fields.templateId,
        sortOrder: t.sortOrder ?? i,
        status: "pending",
      } as InsertTask);
      nameToId.set(t.name, task.id);
      createdTasks.push(task);
    }

    // Resolve name → id for every dependsOn. A name that does NOT resolve to a
    // sibling is a DANGLING dependency — L2: reject the whole create (mirrors the
    // editor path) instead of silently dropping it. Self/cycle are caught by the
    // shared validateTaskGraph below.
    const resolved = params.tasks.map((paramTask, i) => {
      const names = paramTask.dependsOn ?? [];
      const deps = names.map((name) => nameToId.get(name));
      const dangling = names.filter((_, j) => !deps[j]);
      if (dangling.length > 0) {
        throw new InvalidTaskGraphError(
          `Task "${paramTask.name}" depends on unknown task(s): ${dangling.join(", ")}`,
        );
      }
      return { id: createdTasks[i].id, dependsOn: deps as string[] };
    });
    const graph = validateTaskGraph(resolved);
    if (!graph.ok) throw new InvalidTaskGraphError(graph.reason);

    // Second pass: persist resolved deps + the initial status now the graph is valid.
    for (let i = 0; i < params.tasks.length; i++) {
      const dbTask = createdTasks[i];
      const resolvedDeps = resolved[i].dependsOn;
      const status = resolvedDeps.length === 0 ? "ready" : "blocked";
      const updated = await this.storage.updateTask(dbTask.id, {
        dependsOn: resolvedDeps,
        status,
      });
      createdTasks[i] = updated;

      this.broadcast(group.id, {
        type: "task:created",
        runId: group.id,
        payload: { taskId: dbTask.id, name: dbTask.name, status, dependsOn: resolvedDeps },
        timestamp: new Date().toISOString(),
      });
    }

    return { group, tasks: createdTasks };
  }

  /**
   * Start (or RE-run) a task group — creates a fresh iteration with one execution
   * per definition and kicks off the ready ones. Rejects only if the latest
   * iteration is still running, or the configured iteration cap is hit.
   *
   * Default (`options.await !== false`): AWAITS the whole batch and returns the
   * SETTLED group/iteration — UNCHANGED historical behaviour for every existing
   * caller/test. Pass `{ await: false }` (or call `startGroupAsync`) for the
   * §14.5 fire-and-forget path that returns the freshly-created rows immediately.
   */
  async startGroup(groupId: string, options: StartGroupOptions = {}): Promise<{
    group: TaskGroupRow;
    iteration: TaskGroupIterationRow;
  }> {
    const prepared = await this.prepareGroupStart(groupId, options);
    const { group, iteration, iterationNumber, ready, definitions, projected } = prepared;

    if (options.await === false) {
      // §14.5: dispatch fire-and-forget and return the just-created rows NOW.
      // The risk guard fails the iteration/group on a top-level batch rejection
      // so deriveReviewEvent later sees `failed`, never a perpetual `running`.
      void this.launchBatch(ready, MAX_CONCURRENT_TASKS, group, iteration, definitions)
        .catch((err) => this.failIterationBackground(group, iteration, err));
      return { group: projected, iteration };
    }

    await this.launchBatch(ready, MAX_CONCURRENT_TASKS, group, iteration, definitions);

    const settled = (await this.storage.getTaskGroup(groupId)) ?? projected;
    const settledIteration = (await this.storage.getIteration(groupId, iterationNumber)) ?? iteration;
    return { group: settled, iteration: settledIteration };
  }

  /**
   * §14.5 non-blocking entry point. Creates the iteration + executions, marks the
   * group `running`, dispatches the batch fire-and-forget, and returns the
   * just-created `{group, iteration}` IMMEDIATELY (does NOT await completion).
   * Thin alias over `startGroup({ await: false })` so the loop controller has an
   * explicit, intention-revealing seam; existing awaiting callers are untouched.
   */
  async startGroupAsync(groupId: string, options: StartGroupOptions = {}): Promise<{
    group: TaskGroupRow;
    iteration: TaskGroupIterationRow;
  }> {
    return this.startGroup(groupId, { ...options, await: false });
  }

  /**
   * SYNCHRONOUS (pre-launch) half of a start: validate, create the iteration +
   * executions, mark the group `running`, open tracing, broadcast `started`.
   * Shared verbatim by both the awaiting and non-awaiting paths so neither can
   * drift. Returns everything the caller needs to launch the batch.
   */
  private async prepareGroupStart(
    groupId: string,
    options: StartGroupOptions,
  ): Promise<{
    group: TaskGroupRow;
    iteration: TaskGroupIterationRow;
    iterationNumber: number;
    ready: TaskExecutionRow[];
    definitions: TaskRow[];
    projected: TaskGroupRow;
  }> {
    const group = await this.storage.getTaskGroup(groupId);
    if (!group) throw new Error(`TaskGroup ${groupId} not found`);

    const latest = await this.storage.getLatestIteration(groupId);
    if (latest?.status === "running") throw new RunActiveError(groupId);

    const iterationNumber = (latest?.iterationNumber ?? 0) + 1;
    const cap = configLoader.get().pipeline.taskGroups.maxIterationsPerGroup;
    if (cap > 0 && iterationNumber > cap) throw new IterationCapError(groupId, cap);

    const definitions = await this.storage.getTasksByGroup(groupId);
    const seeds = this.buildSeeds(definitions);

    // H1: a start with ZERO ready seeds (0-definition group, or all-blocked
    // graph) can never settle. Reject BEFORE creating an iteration so the group
    // is never left dangling-running; the route maps this to 400 (design §5.1).
    if (!seeds.some((seed) => seed.status === "ready")) {
      throw new NoReadyTasksError(groupId);
    }

    // Human-in-the-loop carry-forward: if the previous iteration carries a human
    // note (thoughts/decisions written after it finished), fold it into THIS
    // iteration's input snapshot so every step argues with the user's input in
    // scope. Only the latest iteration's note is carried.
    const iterationInput = composeIterationInput(group.input, latest?.humanNote ?? null);

    const { iteration, executions } = await this.storage.createIterationWithExecutions(
      groupId,
      { input: iterationInput, triggeredBy: options.triggeredBy ?? null, iterationNumber },
      seeds,
    );

    // M1: mark the group live BEFORE any launch, independent of the tracer.
    this.activeGroupIds.add(groupId);

    const projected = await this.storage.updateTaskGroup(groupId, {
      status: "running",
      startedAt: new Date(),
      completedAt: null,
      output: null,
    });

    await this.tracing.openIteration(group, iteration);

    const ready = executions.filter((e) => e.status === "ready");
    this.broadcast(groupId, {
      type: "taskgroup:started",
      runId: groupId,
      payload: { totalTasks: executions.length, readyTasks: ready.length },
      timestamp: new Date().toISOString(),
    });

    return { group, iteration, iterationNumber, ready, definitions, projected };
  }

  /**
   * §14.5 risk guard. On the fire-and-forget path a TOP-LEVEL `launchBatch`
   * rejection (one that escaped the per-execution try/catch and the
   * `Promise.allSettled` inside `launchBatch`) must not be swallowed — it would
   * otherwise leave the iteration `running` forever. Mirror the iteration/group
   * failure projection from `onTaskFailed` so `deriveReviewEvent` sees `failed`.
   *
   * CRITICAL: fail ONLY if the iteration is STILL non-terminal. The executions
   * settle the iteration/group THEMSELVES (onTaskCompleted/onTaskFailed →
   * checkGroupCompletion) DURING the awaited chain, so a `launchBatch` rejection
   * that arrives AFTER the group already reached `completed` (a stray
   * post-completion throw — broadcast/tracing/transient storage error in the
   * recursive onTaskCompleted→launchBatch path) must NOT stomp the completed
   * group to `failed` (the live-run pipeline_run regression: runs completed 6/6
   * yet the group flipped to failed 0/N). Re-read the current status and no-op
   * when terminal. The awaiting path never touched group status on rejection;
   * this restores that invariant for the non-blocking path. Self-guarded: never
   * re-throws (no unhandled rejection).
   */
  private async failIterationBackground(
    group: TaskGroupRow,
    iteration: TaskGroupIterationRow,
    err: unknown,
  ): Promise<void> {
    const error = err instanceof Error ? err.message : String(err);
    try {
      // Re-read by number (the held row may be stale) — only fail if the
      // executions have NOT already driven the iteration to a terminal state.
      const current = await this.storage.getIteration(group.id, iteration.iterationNumber);
      const status = current?.status ?? iteration.status;
      if (status !== "running" && status !== "pending") return; // already settled → no-op

      await this.storage.updateIteration(iteration.id, { status: "failed", completedAt: new Date() });
      await this.storage.updateTaskGroup(group.id, { status: "failed", completedAt: new Date() });
      this.markGroupSettled(group.id, iteration.id);
      this.tracing.failGroup(group.id, error);
      this.broadcast(group.id, {
        type: "taskgroup:failed",
        runId: group.id,
        payload: { error },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Swallow: the failure projection is best-effort. Re-throwing here would
      // resurrect the unhandled rejection this guard exists to prevent.
    }
  }

  /**
   * Launch up to `slots` ready executions, each ATOMICALLY claimed first (C1).
   * `claim` is synchronous (no await) so two racing callers cannot both launch
   * the same join node; an already-claimed execution is skipped here.
   */
  private async launchBatch(
    candidates: TaskExecutionRow[],
    slots: number,
    group: TaskGroupRow,
    iteration: TaskGroupIterationRow,
    definitions: TaskRow[],
  ): Promise<void> {
    const launched: TaskExecutionRow[] = [];
    for (const e of candidates) {
      if (launched.length >= slots) break;
      if (this.claims.claim(iteration.id, e.id)) launched.push(e);
    }
    await Promise.allSettled(
      launched.map((e) => this.executeExecution(e, group, iteration, definitions)),
    );
  }

  /** Seed one execution per definition: ready iff no deps, else blocked. */
  private buildSeeds(definitions: TaskRow[]): IterationExecutionSeed[] {
    const configuredDefault = configLoader.get().pipeline.taskGroups.defaultModel;
    return definitions.map((d) => ({
      taskId: d.id,
      taskName: d.name,
      status: (d.dependsOn as string[]).length === 0 ? "ready" : "blocked",
      modelSlug: d.modelSlug ?? configuredDefault ?? DEFAULT_TASK_MODEL,
    }));
  }

  /**
   * Cancel the group's active iteration: every non-terminal execution + the
   * iteration row + the group row go `cancelled`.
   */
  async cancelGroup(groupId: string): Promise<void> {
    const latest = await this.storage.getLatestIteration(groupId);
    if (latest) {
      const execs = await this.storage.getExecutionsByIteration(groupId, latest.id);
      for (const e of execs) {
        if (e.status === "running" || e.status === "ready" || e.status === "blocked") {
          await this.storage.updateExecution(e.id, { status: "cancelled" });
        }
      }
      await this.storage.updateIteration(latest.id, { status: "cancelled", completedAt: new Date() });
      this.claims.clear(latest.id);
    }
    await this.storage.updateTaskGroup(groupId, { status: "cancelled", completedAt: new Date() });
    this.activeGroupIds.delete(groupId);
    this.tracing.completeGroup(groupId);

    this.broadcast(groupId, {
      type: "taskgroup:failed",
      runId: groupId,
      payload: { error: "Cancelled by user" },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Retry a single FAILED execution in the LATEST iteration (PR #374 per-task
   * retry, re-targeted at the execution layer). Re-runs only that execution.
   */
  async retryTask(taskId: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const group = await this.storage.getTaskGroup(task.groupId);
    if (!group) throw new Error(`TaskGroup ${task.groupId} not found`);

    const iteration = await this.storage.getLatestIteration(group.id);
    if (!iteration) throw new Error(`TaskGroup ${group.id} has no iteration to retry`);

    const execs = await this.storage.getExecutionsByIteration(group.id, iteration.id);
    const execution = execs.find((e) => e.taskId === taskId);
    if (!execution) throw new Error(`Task ${taskId} has no execution in the latest iteration`);
    if (execution.status !== "failed") {
      throw new Error(`Task ${taskId} is ${execution.status}, not failed`);
    }

    if (iteration.status === "failed") {
      await this.storage.updateIteration(iteration.id, { status: "running", completedAt: null });
      await this.storage.updateTaskGroup(group.id, { status: "running", completedAt: null });
    }
    // Re-mark live (M1) + free any prior claim so this deliberate re-launch is
    // allowed to re-claim the execution (C1 claim is per-launch, not per-life).
    this.activeGroupIds.add(group.id);
    this.claims.release(iteration.id, execution.id);

    const reset = await this.storage.updateExecution(execution.id, {
      status: "ready",
      output: null,
      summary: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    });
    const definitions = await this.storage.getTasksByGroup(group.id);
    if (!this.claims.claim(iteration.id, reset.id)) return;
    await this.executeExecution(reset, group, iteration, definitions);
  }

  // ─── Private: execution ───────────────────────────────────────────────────

  private async executeExecution(
    execution: TaskExecutionRow,
    group: TaskGroupRow,
    iteration: TaskGroupIterationRow,
    definitions: TaskRow[],
  ): Promise<void> {
    const task = definitions.find((d) => d.id === execution.taskId);
    if (!task) return;
    await this.storage.updateExecution(execution.id, { status: "running", startedAt: new Date() });

    const taskSpanId = this.tracing.startTaskSpan(group.id, task);
    this.broadcast(group.id, {
      type: "task:started",
      runId: group.id,
      payload: {
        taskId: task.id,
        name: task.name,
        executionMode: task.executionMode,
        modelSlug: task.modelSlug,
      },
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await this.runExecutionBody(execution, task, group, iteration, definitions);

      await this.storage.updateExecution(execution.id, {
        status: "completed",
        output: result.output ?? null,
        summary: result.summary,
        artifacts: result.artifacts ?? null,
        decisions: result.decisions ?? null,
        completedAt: new Date(),
      });
      this.tracing.completeTaskSpan(group.id, task.id, taskSpanId);
      this.broadcast(group.id, {
        type: "task:completed",
        runId: group.id,
        payload: {
          taskId: task.id,
          name: task.name,
          summary: result.summary,
          artifacts: result.artifacts,
          decisions: result.decisions,
        },
        timestamp: new Date().toISOString(),
      });
      await this.onTaskCompleted(group, iteration, definitions);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.tracing.failTaskSpan(group.id, taskSpanId, errorMessage);
      await this.onTaskFailed(execution, task, group, iteration, definitions, errorMessage);
    }
  }

  /**
   * Dispatch one execution to its mode. L1: a `pipeline_run` task with a null
   * `pipelineId` is an explicit MissingPipelineError — it must NOT silently fall
   * through to direct_llm (which would run the wrong mode at cost).
   */
  private async runExecutionBody(
    execution: TaskExecutionRow,
    task: TaskRow,
    group: TaskGroupRow,
    iteration: TaskGroupIterationRow,
    definitions: TaskRow[],
  ): Promise<TaskResult> {
    if (task.executionMode === "pipeline_run") {
      if (!task.pipelineId) throw new MissingPipelineError(task.name);
      return this.executePipelineRun(execution, task, group);
    }
    return this.executeDirectLlm(execution, task, group, iteration, definitions);
  }

  private async executeDirectLlm(
    execution: TaskExecutionRow,
    task: TaskRow,
    group: TaskGroupRow,
    iteration: TaskGroupIterationRow,
    definitions: TaskRow[],
  ): Promise<TaskResult> {
    // A model-less direct_llm task MUST resolve to a REAL model — NEVER "mock"
    // (a "mock" default makes the group "complete" instantly with canned garbage
    // at cost 0; PR #375). Default from pipeline.taskGroups.defaultModel
    // (DEFAULT_TASK_MODEL fallback). The RESOLVED slug is persisted to model_slug.
    const configuredDefault = configLoader.get().pipeline.taskGroups.defaultModel;
    const modelSlug = task.modelSlug ?? configuredDefault ?? DEFAULT_TASK_MODEL;
    await this.storage.updateExecution(execution.id, { modelSlug });

    const llmSpanId = this.tracing.startLlmSpan(group.id, task.id, modelSlug);

    // Assemble context from completed dependency EXECUTIONS in this iteration.
    const execs = await this.storage.getExecutionsByIteration(group.id, iteration.id);
    const depOutputs = collectDepOutputs(task, definitions, execs);
    const systemPrompt = buildSystemPrompt(task, group, iteration, depOutputs);
    const inputContent = typeof task.input === "string" ? task.input : JSON.stringify(task.input);

    // Run via the STREAMING path: a strong model (Opus) reasoning over a large
    // dependency-output context (a debate round seeing prior rounds) can think
    // ~100s silently then emit a long answer; the non-streaming CLI buffers the
    // whole response and gets killed by the wall-clock cap, whereas streaming
    // drains deltas incrementally. Overall cap is the configurable per-task
    // timeout; no idle cap so a long initial think is not mistaken for a stall.
    const taskTimeoutMs = configLoader.get().pipeline.taskGroups.taskTimeoutMs;
    const request: GatewayRequest = {
      modelSlug,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: inputContent },
      ],
      temperature: 0.7,
      maxTokens: 4096,
    };
    // fix (judge timeout resilience): the judge's largest-context call can hit
    // the wall-clock cap and return 0 tokens; completeDirectLlm adds an optional
    // single bounded retry (default OFF ⇒ byte-identical to the single call above).
    const { response, retry } = await this.completeDirectLlm(request, {
      overallTimeoutMs: taskTimeoutMs,
    });

    this.tracing.completeLlmSpan(group.id, llmSpanId, {
      response,
      modelSlug: response.modelSlug,
      inputContent,
    });
    return annotateRetry(parseDirectLlmResponse(response.content), retry);
  }

  /**
   * Run the direct_llm gateway call with an OPTIONAL single bounded retry
   * (fix: bounded retry with model fallback for judge timeouts). Config
   * `pipeline.consiliumLoop.judgeRetry` is default-OFF ⇒ EXACTLY ONE attempt and
   * ANY throw/empty propagates unchanged (byte-identical to pre-fix; the FSM/
   * reducer failure path is untouched). When enabled, a first attempt that ends
   * in a gateway TIMEOUT (throw) or an EMPTY (0-token) completion is retried
   * EXACTLY ONCE, optionally under `fallbackModel`.
   *
   * Idempotency (adversarial review, risk 1): the completion is a PURE gateway
   * call — no outbox/webhook/business side effect fires per attempt. The gateway
   * logs one llm_request + cost row per PHYSICAL call, which is the intended
   * per-attempt accounting, so a retry cannot double-charge a business action or
   * duplicate a side effect.
   *
   * Bound (adversarial review, risk 2): EXACTLY one retry. A second timeout/error
   * is NOT caught here — it propagates so the task fails cleanly (retry exhausted
   * → today's failure path). No backoff/exponential machinery, so no retry storms.
   */
  private async completeDirectLlm(
    request: GatewayRequest,
    streamOptions: StreamingStageOptions,
  ): Promise<{ response: GatewayResponse; retry: RetryNote | null }> {
    const cfg = configLoader.get().pipeline.consiliumLoop.judgeRetry;

    let cause: RetryNote["cause"];
    try {
      const response = await this.gateway.completeStreaming(request, undefined, undefined, streamOptions);
      // Disabled OR a non-empty completion ⇒ today's behaviour, no retry.
      if (!cfg.enabled || !isEmptyCompletion(response)) return { response, retry: null };
      cause = "empty output";
    } catch (err) {
      // Disabled OR a non-timeout error ⇒ propagate exactly as today.
      if (!cfg.enabled || !isTimeoutError(err)) throw err;
      cause = "timeout";
    }

    // ── single bounded retry (enabled AND timeout/empty only) ──
    const retriedModel = cfg.fallbackModel ?? request.modelSlug;
    const retryRequest: GatewayRequest = { ...request, modelSlug: retriedModel };
    const response = await this.gateway.completeStreaming(retryRequest, undefined, undefined, streamOptions);
    return {
      response,
      retry: { cause, fallbackModel: cfg.fallbackModel ?? null, retriedModel },
    };
  }

  private async executePipelineRun(
    execution: TaskExecutionRow,
    task: TaskRow,
    group: TaskGroupRow,
  ): Promise<TaskResult> {
    const inputText = typeof task.input === "string" ? task.input : JSON.stringify(task.input);
    // §14.3: thread the task's workspace (if any) so the pipeline run is recorded
    // against it and its read tools default to it. undefined = today's behaviour.
    const run = await this.pipelineController.startRun(
      task.pipelineId!,
      inputText,
      undefined,
      undefined,
      task.workspaceId ?? undefined,
    );

    await this.storage.updateExecution(execution.id, { pipelineRunId: run.id });

    const pipelineSpanId = this.tracing.startPipelineSpan(group.id, task.id, run.id);
    try {
      const result = await this.pollRunCompletion(run.id);
      this.tracing.completePipelineSpan(group.id, pipelineSpanId, run.id);
      return {
        summary: typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200),
        output: typeof result === "object" && result !== null ? result as Record<string, unknown> : { raw: result },
      };
    } catch (err) {
      this.tracing.failPipelineSpan(group.id, pipelineSpanId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private pollRunCompletion(runId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      // H2: the poll body is fully wrapped in try/catch so a THROW from
      // storage.getPipelineRun (transient error) rejects the promise instead of
      // escaping as an unhandled rejection — which previously left the execution
      // `running` forever (the timeout never tripped, the promise never settled).
      // Each setTimeout(poll) re-entry runs through this same guard.
      const poll = async (): Promise<void> => {
        try {
          const run = await this.storage.getPipelineRun(runId);
          if (!run) {
            reject(new Error(`Pipeline run ${runId} not found`));
            return;
          }

          if (run.status === "completed") {
            resolve(run.output);
            return;
          }
          if (run.status === "failed" || run.status === "cancelled" || run.status === "rejected") {
            reject(new Error(`Pipeline run ${runId} ended with status: ${run.status}`));
            return;
          }

          if (Date.now() - startTime > PIPELINE_POLL_TIMEOUT_MS) {
            reject(new Error(`Pipeline run ${runId} timed out after ${PIPELINE_POLL_TIMEOUT_MS}ms`));
            return;
          }

          // Re-arm; catch a synchronous scheduling throw defensively.
          setTimeout(() => {
            void poll();
          }, PIPELINE_POLL_INTERVAL_MS);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };

      void poll();
    });
  }

  // ─── Private: dependency resolution (EXECUTION-scoped, active iteration) ────

  private async onTaskCompleted(
    group: TaskGroupRow,
    iteration: TaskGroupIterationRow,
    definitions: TaskRow[],
  ): Promise<void> {
    const groupId = group.id;
    const execs = await this.storage.getExecutionsByIteration(groupId, iteration.id);
    const completedTaskIds = new Set(
      execs.filter((e) => e.status === "completed").map((e) => e.taskId),
    );

    // Unblock executions whose dependency definitions are all completed.
    const newlyReady: TaskExecutionRow[] = [];
    for (const e of execs) {
      if (e.status !== "blocked") continue;
      const def = definitions.find((d) => d.id === e.taskId);
      const deps = (def?.dependsOn as string[]) ?? [];
      if (deps.every((depId) => completedTaskIds.has(depId))) {
        const updated = await this.storage.updateExecution(e.id, { status: "ready" });
        newlyReady.push(updated);
        this.broadcast(groupId, {
          type: "task:ready",
          runId: groupId,
          payload: { taskId: e.taskId, name: def?.name ?? e.taskId },
          timestamp: new Date().toISOString(),
        });
      }
    }

    const completedCount = execs.filter((e) => e.status === "completed").length;
    const runningCount = execs.filter((e) => e.status === "running").length;
    this.broadcast(groupId, {
      type: "taskgroup:progress",
      runId: groupId,
      payload: { completed: completedCount, total: execs.length, running: runningCount },
      timestamp: new Date().toISOString(),
    });

    // C1: launch newly-ready executions through the atomic claim path so a
    // join node unblocked by two racing completions launches exactly once.
    const slotsAvailable = Math.max(0, MAX_CONCURRENT_TASKS - runningCount);
    await this.launchBatch(newlyReady, slotsAvailable, group, iteration, definitions);

    await this.checkGroupCompletion(group, iteration, definitions);
  }

  private async onTaskFailed(
    execution: TaskExecutionRow,
    task: TaskRow,
    group: TaskGroupRow,
    iteration: TaskGroupIterationRow,
    definitions: TaskRow[],
    error: string,
  ): Promise<void> {
    await this.storage.updateExecution(execution.id, {
      status: "failed",
      errorMessage: error,
      completedAt: new Date(),
    });

    this.broadcast(group.id, {
      type: "task:failed",
      runId: group.id,
      payload: { taskId: task.id, name: task.name, error },
      timestamp: new Date().toISOString(),
    });

    // M2: every downstream execution made UNREACHABLE by this failure is left
    // non-terminal (blocked/ready/pending) — mark them `cancelled` so the
    // iteration's execution history is cleanly terminal (no permanently-blocked
    // rows) and checkGroupCompletion can settle.
    await this.cancelUnreachable(group.id, iteration, definitions);

    // Project failure onto BOTH the active iteration and the group.
    await this.storage.updateIteration(iteration.id, { status: "failed", completedAt: new Date() });
    await this.storage.updateTaskGroup(group.id, { status: "failed", completedAt: new Date() });
    this.markGroupSettled(group.id, iteration.id);
    this.tracing.failGroup(group.id, error);

    this.broadcast(group.id, {
      type: "taskgroup:failed",
      runId: group.id,
      payload: { error, failedTaskId: task.id, failedTaskName: task.name },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Cancel every non-terminal execution that can no longer run because a
   * dependency failed (M2). Computes the set of FAILED definitions in this
   * iteration, then transitively any execution whose dependency chain hits a
   * failed/cancelled node; marks those `cancelled`. Idempotent + iteration-scoped.
   */
  private async cancelUnreachable(
    groupId: string,
    iteration: TaskGroupIterationRow,
    definitions: TaskRow[],
  ): Promise<void> {
    const execs = await this.storage.getExecutionsByIteration(groupId, iteration.id);
    const statusByTask = new Map(execs.map((e) => [e.taskId, e.status]));
    const blocked = (taskId: string | null): boolean => {
      const def = definitions.find((d) => d.id === taskId);
      const deps = (def?.dependsOn as string[]) ?? [];
      return deps.some((depId) => {
        const ds = statusByTask.get(depId);
        return ds === "failed" || ds === "cancelled";
      });
    };
    // Fixpoint: cancelling one row can make its own dependents unreachable, so
    // repeat until no further row flips (handles arbitrary execution ordering).
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of execs) {
        const fresh = statusByTask.get(e.taskId);
        const nonTerminal = fresh === "blocked" || fresh === "ready" || fresh === "pending";
        if (nonTerminal && blocked(e.taskId)) {
          await this.storage.updateExecution(e.id, { status: "cancelled", completedAt: new Date() });
          statusByTask.set(e.taskId, "cancelled");
          changed = true;
        }
      }
    }
  }

  /** Drop the group from the live set + free its per-iteration claims (settle). */
  private markGroupSettled(groupId: string, iterationId: string): void {
    this.activeGroupIds.delete(groupId);
    this.claims.clear(iterationId);
  }

  private async checkGroupCompletion(
    group: TaskGroupRow,
    iteration: TaskGroupIterationRow,
    definitions: TaskRow[],
  ): Promise<void> {
    const execs = await this.storage.getExecutionsByIteration(group.id, iteration.id);
    const allDone = execs.every((e) => e.status === "completed" || e.status === "cancelled");
    if (!allDone) return;

    const summaries = execs
      .filter((e) => e.status === "completed" && e.summary)
      .map((e) => {
        const def = definitions.find((d) => d.id === e.taskId);
        return `- ${def?.name ?? e.taskId}: ${e.summary}`;
      });

    const output = {
      taskCount: execs.length,
      completedCount: execs.filter((e) => e.status === "completed").length,
      summaries: summaries.join("\n"),
    };

    // Project terminal status + aggregate onto BOTH the iteration and the group.
    await this.storage.updateIteration(iteration.id, {
      status: "completed",
      output,
      completedAt: new Date(),
    });
    await this.storage.updateTaskGroup(group.id, {
      status: "completed",
      output,
      completedAt: new Date(),
    });
    this.markGroupSettled(group.id, iteration.id);
    this.tracing.completeGroup(group.id);

    this.broadcast(group.id, {
      type: "taskgroup:completed",
      runId: group.id,
      payload: { totalTasks: execs.length, completedTasks: output.completedCount, output },
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Private: WebSocket broadcast ─────────────────────────────────────────

  private broadcast(groupId: string, event: WsEvent): void {
    this.wsManager.broadcastToRun(groupId, event);
  }
}
