/**
 * Task Groups v2 — shared storage contracts (task-groups-v2 §3 / BE2).
 *
 * Extracted into its own module so BOTH `storage.ts` (MemStorage) and
 * `storage-pg.ts` (PgStorage) can import the typed error, query shapes, and the
 * lazy virtual-iteration adapter WITHOUT a circular value import between them.
 */
import type {
  TaskGroupRow,
  TaskRow,
  TaskGroupIterationRow,
  TaskExecutionRow,
  TaskStatus,
} from "@shared/schema";


// ─── Task Groups v2 — iterations / executions / templates (task-groups-v2 §3) ─

/** Max rows a single iteration/template list page returns (caller-enforced too). */
export const TASK_GROUP_V2_MAX_LIMIT = 100;

/**
 * Keyset cursor for the iteration list (`iteration_number desc`). The cursor is
 * exclusive: only iterations strictly *lower* than `iterationNumber` are returned.
 * The route encodes/decodes this as an opaque base64url string (reuses the
 * activity.ts CursorSchema idiom); storage receives it already decoded.
 */
export interface IterationListQuery {
  /** Max rows to return; clamped to <= TASK_GROUP_V2_MAX_LIMIT. */
  limit: number;
  cursor?: { iterationNumber: number };
}

/**
 * Keyset cursor for the template list (`created_at desc, id desc`), exclusive.
 * Owner filter is applied BEFORE the label match (MF-4: a non-admin must not be
 * able to enumerate another tenant's templates by label).
 */
export interface TaskTemplateListQuery {
  /** When set, restrict to templates owned by this user (non-admin scoping). */
  ownerId?: string;
  /** Whether the caller is an admin (admins see all owners). */
  isAdmin: boolean;
  /** Optional label-containment filter (a template matches if labels includes it). */
  label?: string;
  limit: number;
  cursor?: { createdAt: string; id: string };
}

/**
 * Thrown when an iteration insert collides on UNIQUE(group_id, iteration_number)
 * — i.e. two concurrent `start` calls computed the same `max + 1`. The route maps
 * this to HTTP 409 (SF-1 / §4.1.d concurrency backstop).
 */
export class IterationConflictError extends Error {
  readonly code = "ITERATION_CONFLICT" as const;
  constructor(
    readonly groupId: string,
    readonly iterationNumber: number,
  ) {
    super(`Iteration ${iterationNumber} already exists for group ${groupId}`);
    this.name = "IterationConflictError";
  }
}

/** One definition's seed for an atomic iteration start (SF-1). */
export interface IterationExecutionSeed {
  taskId: string;
  /**
   * Denormalized definition name, captured at seed time (SEC1). Persisted to
   * task_executions.task_name so history survives a later definition delete.
   */
  taskName: string;
  /** Initial status — typically 'ready' (no deps) or 'blocked' (has deps). */
  status: TaskStatus;
  /** The resolved model recorded at seed time, if already known. */
  modelSlug?: string | null;
}

/** Inputs for the atomic iteration start (SF-1, §4.1.d/e). */
export interface IterationStartInput {
  /** Immutable snapshot of the group input at run time. */
  input: string;
  triggeredBy?: string | null;
  /** Iteration number to claim; UNIQUE(group, number) is the race backstop. */
  iterationNumber: number;
  traceId?: string | null;
}

/**
 * A read-only, synthesized iteration for a pre-v2 group that has zero real
 * iteration rows (§8 lazy virtual-iteration adapter, MF-5). The adapter reads the
 * legacy `tasks` execution columns and projects them as iteration 1 + executions.
 * `virtual: true` marks it so callers never attempt to persist or mutate it.
 */
export interface VirtualIteration {
  iteration: TaskGroupIterationRow;
  executions: TaskExecutionRow[];
  virtual: true;
}

/**
 * Synthesize a read-only "iteration 1" + executions for a pre-v2 group from the
 * legacy `tasks` execution columns (task-groups-v2 §8 lazy virtual-iteration
 * adapter, MF-5). Pure projection — never persisted. Shared by MemStorage and
 * PgStorage so the legacy read is identical across impls (QA parity).
 */
export function buildVirtualIteration(group: TaskGroupRow, tasks: TaskRow[]): VirtualIteration {
  const virtualIterationId = `virtual:${group.id}:1`;
  const iteration: TaskGroupIterationRow = {
    id: virtualIterationId,
    groupId: group.id,
    iterationNumber: 1,
    status: group.status,
    input: group.input,
    output: (group.output as Record<string, unknown> | null) ?? null,
    traceId: group.traceId ?? null,
    triggeredBy: group.createdBy ?? null,
    startedAt: group.startedAt ?? null,
    completedAt: group.completedAt ?? null,
    createdAt: group.createdAt ?? new Date(),
  };
  const executions: TaskExecutionRow[] = tasks.map((t) => ({
    id: `virtual:${t.id}`,
    iterationId: virtualIterationId,
    taskId: t.id,
    taskName: t.name,
    groupId: group.id,
    status: t.status,
    output: t.output ?? null,
    summary: t.summary ?? null,
    artifacts: t.artifacts ?? null,
    decisions: t.decisions ?? null,
    errorMessage: t.errorMessage ?? null,
    modelSlug: t.modelSlug ?? null,
    pipelineRunId: t.pipelineRunId ?? null,
    startedAt: t.startedAt ?? null,
    completedAt: t.completedAt ?? null,
    createdAt: t.createdAt ?? new Date(),
  }));
  return { iteration, executions, virtual: true };
}
