/**
 * Typed errors thrown by the Task Groups v2 orchestrator, extracted from
 * task-orchestrator.ts (L3 — keep the orchestrator file <800 lines). Re-exported
 * from `task-orchestrator.ts` so existing import paths are unchanged.
 *
 * The route layer maps each to an HTTP status:
 *   RunActiveError / IterationCapError      → 409
 *   NoReadyTasksError / InvalidTaskGraphError → 400
 */

/**
 * Thrown when `start` is called while the group's latest iteration is still
 * `running` (replaces the old `status !== "pending"` one-shot guard). The route
 * maps this to HTTP 409. Distinct from `IterationConflictError` (the UNIQUE-race
 * backstop), but both surface as 409 at the boundary.
 */
export class RunActiveError extends Error {
  readonly code = "RUN_ACTIVE" as const;
  constructor(groupId: string) {
    super(`TaskGroup ${groupId} already has a running iteration`);
    this.name = "RunActiveError";
  }
}

/**
 * Thrown when `start` would exceed the configured `maxIterationsPerGroup` soft
 * cap (R3/SF-3). The route maps this to HTTP 409.
 */
export class IterationCapError extends Error {
  readonly code = "ITERATION_CAP" as const;
  constructor(
    readonly groupId: string,
    readonly cap: number,
  ) {
    super(`TaskGroup ${groupId} reached the ${cap}-iteration cap`);
    this.name = "IterationCapError";
  }
}

/**
 * Thrown by `startGroup` when the group has ZERO `ready` seed executions (a
 * 0-definition group, or an all-blocked graph with no satisfiable seed). It is
 * raised BEFORE any iteration row is created, so the group is never left with a
 * dangling `running` iteration that can never settle (H1). The `/start` route
 * maps it to HTTP 400 ("no ready tasks", design §5.1).
 */
export class NoReadyTasksError extends Error {
  readonly code = "NO_READY_TASKS" as const;
  readonly status = 400 as const;
  constructor(groupId: string) {
    super(`TaskGroup ${groupId} has no ready tasks to start`);
    this.name = "NoReadyTasksError";
  }
}

/**
 * Thrown by `createTaskGroup` when the resolved dependency graph is invalid —
 * a dangling/self/cyclic `dependsOn` (L2). Mirrors the editor path's
 * `validateTaskGraph` rejection so the create path no longer silently drops
 * unresolvable references. The route maps it to HTTP 400.
 */
export class InvalidTaskGraphError extends Error {
  readonly code = "INVALID_TASK_GRAPH" as const;
  readonly status = 400 as const;
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidTaskGraphError";
  }
}
