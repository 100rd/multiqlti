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

export function useTaskTrace(groupId: string) {
  return useQuery<TaskTraceData>({
    queryKey: ["/api/task-groups", groupId, "trace"],
    queryFn: () => apiRequest("GET", `/api/task-groups/${groupId}/trace`),
    enabled: !!groupId,
    refetchInterval: 3000,
  });
}
