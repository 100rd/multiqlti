import type { IStorage } from "../storage";
import type { WsManager } from "../ws/manager";
import type { PipelineController } from "../controller/pipeline-controller";
import type { Gateway } from "../gateway/index";
import type { TaskGroupRow, TaskRow, InsertTaskGroup, InsertTask } from "@shared/schema";
import type { WsEvent, TaskResult } from "@shared/types";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CONCURRENT_TASKS = 5;
const PIPELINE_POLL_INTERVAL_MS = 2000;
const PIPELINE_POLL_TIMEOUT_MS = 600_000; // 10 min

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateTaskGroupParams {
  name: string;
  description: string;
  input: string;
  tasks: Array<{
    name: string;
    description: string;
    executionMode?: "pipeline_run" | "direct_llm";
    dependsOn?: string[]; // task names within this group
    pipelineId?: string;
    modelSlug?: string;
    teamId?: string;
    input?: Record<string, unknown>;
    sortOrder?: number;
  }>;
  createdBy?: string;
}

// ─── Task Orchestrator ──────────────────────────────────────────────────────

export class TaskOrchestrator {
  constructor(
    private storage: IStorage,
    private wsManager: WsManager,
    private pipelineController: PipelineController,
    private gateway: Gateway,
  ) {}

  /**
   * Create a task group with tasks. Resolves task name references in
   * dependsOn to IDs and computes initial statuses (ready / blocked).
   */
  async createTaskGroup(params: CreateTaskGroupParams): Promise<{ group: TaskGroupRow; tasks: TaskRow[] }> {
    const group = await this.storage.createTaskGroup({
      name: params.name,
      description: params.description,
      input: params.input,
      status: "pending",
      createdBy: params.createdBy ?? null,
    } as InsertTaskGroup);

    // First pass: create all tasks with placeholder dependsOn
    const nameToId = new Map<string, string>();
    const createdTasks: TaskRow[] = [];

    for (let i = 0; i < params.tasks.length; i++) {
      const t = params.tasks[i];
      const task = await this.storage.createTask({
        groupId: group.id,
        name: t.name,
        description: t.description,
        executionMode: t.executionMode ?? "direct_llm",
        dependsOn: [], // populated in second pass
        pipelineId: t.pipelineId ?? null,
        modelSlug: t.modelSlug ?? null,
        teamId: t.teamId ?? null,
        input: t.input ?? {},
        sortOrder: t.sortOrder ?? i,
        status: "pending",
      } as InsertTask);
      nameToId.set(t.name, task.id);
      createdTasks.push(task);
    }

    // Second pass: resolve name → id for dependsOn and set initial status
    for (let i = 0; i < params.tasks.length; i++) {
      const paramTask = params.tasks[i];
      const dbTask = createdTasks[i];
      const resolvedDeps = (paramTask.dependsOn ?? [])
        .map((name) => nameToId.get(name))
        .filter((id): id is string => !!id);

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
   * Start executing a task group — kicks off all ready tasks.
   */
  async startGroup(groupId: string): Promise<void> {
    const group = await this.storage.getTaskGroup(groupId);
    if (!group) throw new Error(`TaskGroup ${groupId} not found`);
    if (group.status !== "pending") throw new Error(`TaskGroup ${groupId} is already ${group.status}`);

    await this.storage.updateTaskGroup(groupId, { status: "running", startedAt: new Date() });

    const allTasks = await this.storage.getTasksByGroup(groupId);
    const readyTasks = allTasks.filter((t) => t.status === "ready");

    this.broadcast(groupId, {
      type: "taskgroup:started",
      runId: groupId,
      payload: { totalTasks: allTasks.length, readyTasks: readyTasks.length },
      timestamp: new Date().toISOString(),
    });

    // Launch ready tasks (up to concurrency limit)
    const batch = readyTasks.slice(0, MAX_CONCURRENT_TASKS);
    await Promise.allSettled(batch.map((t) => this.executeTask(t, group)));
  }

  /**
   * Cancel the entire group.
   */
  async cancelGroup(groupId: string): Promise<void> {
    const allTasks = await this.storage.getTasksByGroup(groupId);
    for (const t of allTasks) {
      if (t.status === "running" || t.status === "ready" || t.status === "blocked") {
        await this.storage.updateTask(t.id, { status: "cancelled" });
      }
    }
    await this.storage.updateTaskGroup(groupId, { status: "cancelled", completedAt: new Date() });

    this.broadcast(groupId, {
      type: "taskgroup:failed",
      runId: groupId,
      payload: { error: "Cancelled by user" },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Retry a failed task.
   */
  async retryTask(taskId: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== "failed") throw new Error(`Task ${taskId} is ${task.status}, not failed`);

    const group = await this.storage.getTaskGroup(task.groupId);
    if (!group) throw new Error(`TaskGroup ${task.groupId} not found`);

    // Reset group to running if it was failed
    if (group.status === "failed") {
      await this.storage.updateTaskGroup(group.id, { status: "running", completedAt: null });
    }

    await this.storage.updateTask(taskId, {
      status: "ready",
      output: null,
      summary: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    });

    const freshTask = (await this.storage.getTask(taskId))!;
    await this.executeTask(freshTask, group);
  }

  // ─── Private: execution ───────────────────────────────────────────────────

  private async executeTask(task: TaskRow, group: TaskGroupRow): Promise<void> {
    await this.storage.updateTask(task.id, { status: "running", startedAt: new Date() });

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
      let result: TaskResult;

      if (task.executionMode === "pipeline_run" && task.pipelineId) {
        result = await this.executePipelineRun(task, group);
      } else {
        result = await this.executeDirectLlm(task, group);
      }

      await this.storage.updateTask(task.id, {
        status: "completed",
        output: result.output ?? null,
        summary: result.summary,
        artifacts: result.artifacts ?? null,
        decisions: result.decisions ?? null,
        completedAt: new Date(),
      });

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

      await this.onTaskCompleted(task);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.onTaskFailed(task, errorMessage);
    }
  }

  private async executeDirectLlm(task: TaskRow, group: TaskGroupRow): Promise<TaskResult> {
    // Assemble context from completed dependency outputs
    const allTasks = await this.storage.getTasksByGroup(group.id);
    const depOutputs: Record<string, unknown> = {};
    for (const depId of task.dependsOn as string[]) {
      const dep = allTasks.find((t) => t.id === depId);
      if (dep?.output) depOutputs[dep.name] = dep.output;
    }

    const systemPrompt = `You are completing a task as part of a larger task group.
Task group: ${group.name}
Overall objective: ${group.input}

Your specific task: ${task.name}
Description: ${task.description}

${Object.keys(depOutputs).length > 0
  ? `Results from prerequisite tasks:\n${JSON.stringify(depOutputs, null, 2)}`
  : ""}

Respond with a JSON object:
{
  "summary": "Brief summary of what was accomplished",
  "output": { ... any structured output ... },
  "decisions": ["key decision 1", "key decision 2"]
}`;

    const modelSlug = task.modelSlug ?? "mock";
    const response = await this.gateway.complete({
      modelSlug,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: typeof task.input === "string" ? task.input : JSON.stringify(task.input) },
      ],
      temperature: 0.7,
      maxTokens: 4096,
    });

    // Try to parse structured response
    try {
      const parsed = JSON.parse(response.content);
      return {
        summary: parsed.summary ?? response.content.slice(0, 200),
        output: parsed.output ?? { raw: response.content },
        decisions: parsed.decisions ?? [],
        artifacts: parsed.artifacts,
      };
    } catch {
      return {
        summary: response.content.slice(0, 200),
        output: { raw: response.content },
      };
    }
  }

  private async executePipelineRun(task: TaskRow, group: TaskGroupRow): Promise<TaskResult> {
    const inputText = typeof task.input === "string" ? task.input : JSON.stringify(task.input);
    const run = await this.pipelineController.startRun(task.pipelineId!, inputText);

    await this.storage.updateTask(task.id, { pipelineRunId: run.id });

    // Poll for completion
    const result = await this.pollRunCompletion(run.id);
    return {
      summary: typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200),
      output: typeof result === "object" && result !== null ? result as Record<string, unknown> : { raw: result },
    };
  }

  private pollRunCompletion(runId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const poll = async () => {
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

        setTimeout(poll, PIPELINE_POLL_INTERVAL_MS);
      };

      poll();
    });
  }

  // ─── Private: dependency resolution ───────────────────────────────────────

  private async onTaskCompleted(task: TaskRow): Promise<void> {
    const groupId = task.groupId;
    const allTasks = await this.storage.getTasksByGroup(groupId);
    const completedIds = new Set(allTasks.filter((t) => t.status === "completed").map((t) => t.id));

    // Find blocked tasks that can now be unblocked
    const newlyReady: TaskRow[] = [];
    for (const t of allTasks) {
      if (t.status !== "blocked") continue;
      const deps = t.dependsOn as string[];
      if (deps.every((depId) => completedIds.has(depId))) {
        const updated = await this.storage.updateTask(t.id, { status: "ready" });
        newlyReady.push(updated);
        this.broadcast(groupId, {
          type: "task:ready",
          runId: groupId,
          payload: { taskId: t.id, name: t.name },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Broadcast progress
    const completedCount = allTasks.filter((t) => t.status === "completed").length;
    const runningCount = allTasks.filter((t) => t.status === "running").length;
    this.broadcast(groupId, {
      type: "taskgroup:progress",
      runId: groupId,
      payload: { completed: completedCount, total: allTasks.length, running: runningCount },
      timestamp: new Date().toISOString(),
    });

    // Launch newly ready tasks
    const group = (await this.storage.getTaskGroup(groupId))!;
    const activeTasks = allTasks.filter((t) => t.status === "running").length;
    const slotsAvailable = MAX_CONCURRENT_TASKS - activeTasks;
    const batch = newlyReady.slice(0, Math.max(0, slotsAvailable));
    await Promise.allSettled(batch.map((t) => this.executeTask(t, group)));

    // Check if group is complete
    await this.checkGroupCompletion(groupId);
  }

  private async onTaskFailed(task: TaskRow, error: string): Promise<void> {
    await this.storage.updateTask(task.id, {
      status: "failed",
      errorMessage: error,
      completedAt: new Date(),
    });

    this.broadcast(task.groupId, {
      type: "task:failed",
      runId: task.groupId,
      payload: { taskId: task.id, name: task.name, error },
      timestamp: new Date().toISOString(),
    });

    // Fail the group
    await this.storage.updateTaskGroup(task.groupId, { status: "failed", completedAt: new Date() });

    this.broadcast(task.groupId, {
      type: "taskgroup:failed",
      runId: task.groupId,
      payload: { error, failedTaskId: task.id, failedTaskName: task.name },
      timestamp: new Date().toISOString(),
    });
  }

  private async checkGroupCompletion(groupId: string): Promise<void> {
    const allTasks = await this.storage.getTasksByGroup(groupId);
    const allDone = allTasks.every((t) => t.status === "completed" || t.status === "cancelled");
    if (!allDone) return;

    // Aggregate output
    const summaries = allTasks
      .filter((t) => t.status === "completed" && t.summary)
      .map((t) => `- ${t.name}: ${t.summary}`);

    const output = {
      taskCount: allTasks.length,
      completedCount: allTasks.filter((t) => t.status === "completed").length,
      summaries: summaries.join("\n"),
    };

    await this.storage.updateTaskGroup(groupId, {
      status: "completed",
      output,
      completedAt: new Date(),
    });

    this.broadcast(groupId, {
      type: "taskgroup:completed",
      runId: groupId,
      payload: { totalTasks: allTasks.length, completedTasks: output.completedCount, output },
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Private: WebSocket broadcast ─────────────────────────────────────────

  private broadcast(groupId: string, event: WsEvent): void {
    this.wsManager.broadcastToRun(groupId, event);
  }
}
