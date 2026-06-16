import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./use-pipeline";

export interface TaskTraceSpanMetadata {
  taskId?: string;
  pipelineRunId?: string;
  stageIndex?: number;
  modelSlug?: string;
  provider?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  error?: string;
}

export interface TaskTraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  type: "task_group" | "task" | "pipeline_run" | "stage" | "llm_call";
  status: "running" | "completed" | "failed";
  startTime: number;
  endTime?: number;
  durationMs?: number;
  metadata: TaskTraceSpanMetadata;
}

export interface TaskTraceData {
  id: string;
  groupId: string;
  traceId: string;
  rootSpan: TaskTraceSpan | null;
  spans: TaskTraceSpan[];
  totalDurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Fetch a task-group trace. When `iterationNumber` is provided, target the
 * per-iteration trace (`…/iterations/:n/trace`, owner-gated + cross-group
 * re-checked); otherwise the legacy group-level trace (`…/trace`, which aliases
 * the latest iteration server-side). The waterfall rendering is identical for
 * both — only the source endpoint differs (FE1/FE2).
 */
export function useTaskTrace(
  groupId: string,
  iterationNumber?: number | null,
) {
  const hasIteration =
    typeof iterationNumber === "number" && iterationNumber >= 1;
  const url = hasIteration
    ? `/api/task-groups/${groupId}/iterations/${iterationNumber}/trace`
    : `/api/task-groups/${groupId}/trace`;

  return useQuery<TaskTraceData>({
    queryKey: hasIteration
      ? ["/api/task-groups", groupId, "iterations", iterationNumber, "trace"]
      : ["/api/task-groups", groupId, "trace"],
    queryFn: () => apiRequest("GET", url) as Promise<TaskTraceData>,
    enabled: !!groupId,
    refetchInterval: 3000,
  });
}
