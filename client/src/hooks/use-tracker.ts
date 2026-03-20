import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./use-pipeline";

// ─── Queries ────────────────────────────────────────────────────────────────

export function useTrackerConnections(groupId: string) {
  return useQuery({
    queryKey: ["/api/tracker-connections", groupId],
    queryFn: () => apiRequest("GET", `/api/tracker-connections/${groupId}`),
    enabled: !!groupId,
  });
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export function useCreateTrackerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      taskGroupId: string;
      provider: "jira" | "clickup" | "linear" | "github";
      issueUrl: string;
      issueKey: string;
      projectKey?: string | null;
      syncComments?: boolean;
      syncSubtasks?: boolean;
      apiToken?: string | null;
      baseUrl?: string | null;
    }) => apiRequest("POST", "/api/tracker-connections", data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["/api/tracker-connections", vars.taskGroupId],
      });
    },
  });
}

export function useDeleteTrackerConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest("DELETE", `/api/tracker-connections/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tracker-connections"] });
    },
  });
}

export function useSplitPreview() {
  return useMutation({
    mutationFn: (data: { storyText: string; modelSlug: string }) =>
      apiRequest("POST", "/api/task-groups/split-preview", data),
  });
}

export function useSubmitWork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      storyText: string;
      modelSlug: string;
      trackerUrl?: string;
      trackerProvider?: "jira" | "clickup" | "linear" | "github";
      trackerIssueKey?: string;
      trackerApiToken?: string;
      trackerBaseUrl?: string;
    }) => apiRequest("POST", "/api/task-groups/submit-work", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups"] });
    },
  });
}
