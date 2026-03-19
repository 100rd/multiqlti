import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./use-pipeline";

// ─── Queries ────────────────────────────────────────────────────────────────

export function useTaskGroups() {
  return useQuery({
    queryKey: ["/api/task-groups"],
    queryFn: () => apiRequest("GET", "/api/task-groups"),
  });
}

export function useTaskGroup(id: string) {
  return useQuery({
    queryKey: ["/api/task-groups", id],
    queryFn: () => apiRequest("GET", `/api/task-groups/${id}`),
    enabled: !!id,
    refetchInterval: 3000, // poll while viewing
  });
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export function useCreateTaskGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      input: string;
      tasks: Array<{
        name: string;
        description: string;
        executionMode?: "pipeline_run" | "direct_llm";
        dependsOn?: string[];
        pipelineId?: string;
        modelSlug?: string;
        teamId?: string;
        input?: Record<string, unknown>;
        sortOrder?: number;
      }>;
    }) => apiRequest("POST", "/api/task-groups", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups"] });
    },
  });
}

export function useStartTaskGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/task-groups/${id}/start`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups", id] });
      qc.invalidateQueries({ queryKey: ["/api/task-groups"] });
    },
  });
}

export function useCancelTaskGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/task-groups/${id}/cancel`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups", id] });
      qc.invalidateQueries({ queryKey: ["/api/task-groups"] });
    },
  });
}

export function useDeleteTaskGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/task-groups/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups"] });
    },
  });
}

export function useRetryTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, taskId }: { groupId: string; taskId: string }) =>
      apiRequest("POST", `/api/task-groups/${groupId}/tasks/${taskId}/retry`),
    onSuccess: (_data, { groupId }) => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups", groupId] });
    },
  });
}
