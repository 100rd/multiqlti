import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { wsClient } from "@/lib/websocket";

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

export async function apiRequest(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string; error?: string };
    throw new Error(err.message ?? err.error ?? res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ─── Models ─────────────────────────────────────

export function useModels() {
  return useQuery({
    queryKey: ["/api/models"],
    queryFn: () => apiRequest("GET", "/api/models"),
  });
}

export function useActiveModels() {
  return useQuery({
    queryKey: ["/api/models/active"],
    queryFn: () => apiRequest("GET", "/api/models/active"),
  });
}

export function useUpdateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: { id: string } & Record<string, unknown>) =>
      apiRequest("PATCH", `/api/models/${id}`, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/models"] });
    },
  });
}

export function useCreateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("POST", "/api/models", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/models"] });
    },
  });
}

// ─── Teams ──────────────────────────────────────

export function useTeams() {
  return useQuery({
    queryKey: ["/api/teams"],
    queryFn: () => apiRequest("GET", "/api/teams"),
  });
}

// ─── Pipelines ──────────────────────────────────

export function usePipelines() {
  return useQuery({
    queryKey: ["/api/pipelines"],
    queryFn: () => apiRequest("GET", "/api/pipelines"),
  });
}

export function usePipeline(id: string) {
  return useQuery({
    queryKey: ["/api/pipelines", id],
    queryFn: () => apiRequest("GET", `/api/pipelines/${id}`),
    enabled: !!id,
  });
}

export function useCreatePipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("POST", "/api/pipelines", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
    },
  });
}

export function useUpdatePipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: { id: string } & Record<string, unknown>) =>
      apiRequest("PATCH", `/api/pipelines/${id}`, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
    },
  });
}

export function useDeletePipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/pipelines/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
    },
  });
}

// ─── Runs ───────────────────────────────────────
// Polling removed: live run/stage data is delivered via WebSocket.
// A single fetch fires on mount to hydrate the list; WS events keep it fresh.

export function useRuns(pipelineId?: string) {
  const url = pipelineId
    ? `/api/runs?pipelineId=${pipelineId}`
    : "/api/runs";
  return useQuery({
    queryKey: ["/api/runs", pipelineId],
    queryFn: () => apiRequest("GET", url),
    // No refetchInterval — WS handles live updates; invalidate via mutation onSuccess
  });
}

export function usePipelineRun(runId: string) {
  return useQuery({
    queryKey: ["/api/runs", runId],
    queryFn: () => apiRequest("GET", `/api/runs/${runId}`),
    enabled: !!runId,
    // No refetchInterval — WS delivers stage/status events in real time
  });
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      pipelineId: string;
      input: string;
      variables?: Record<string, string>;
      // Optional workspace binding (issue #343). When set, the run is recorded
      // against the workspace and tools default to it.
      workspaceId?: string;
    }) => apiRequest("POST", "/api/runs", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/runs"] });
    },
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiRequest("POST", `/api/runs/${runId}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/runs"] });
    },
  });
}

// ─── Questions ──────────────────────────────────
// Keep polling for questions since they don't arrive via WS reliably on load

export function usePendingQuestions() {
  // Poll aggressively when WS is disconnected; slow-poll as a safety net when WS is connected.
  const refetchInterval = wsClient.isConnected ? 30_000 : 5_000;
  return useQuery({
    queryKey: ["/api/questions/pending"],
    queryFn: () => apiRequest("GET", "/api/questions/pending"),
    refetchInterval,
  });
}

export function useAnswerQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      questionId,
      answer,
    }: {
      runId: string;
      questionId: string;
      answer: string;
    }) =>
      apiRequest(
        "POST",
        `/api/runs/${runId}/questions/${questionId}/answer`,
        { answer },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/questions/pending"] });
      qc.invalidateQueries({ queryKey: ["/api/runs"] });
    },
  });
}

export function useDismissQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      runId,
      questionId,
    }: {
      runId: string;
      questionId: string;
    }) =>
      apiRequest(
        "POST",
        `/api/runs/${runId}/questions/${questionId}/dismiss`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/questions/pending"] });
      qc.invalidateQueries({ queryKey: ["/api/runs"] });
    },
  });
}

// ─── Chat ───────────────────────────────────────
// Chat messages for a run are delivered via WS; no polling needed

export function useChatMessages(runId?: string) {
  return useQuery({
    queryKey: ["/api/chat", runId, "messages"],
    queryFn: () => apiRequest("GET", `/api/chat/${runId}/messages`),
    enabled: !!runId,
    // No refetchInterval — WS delivers chat:message events
  });
}

export function useSendChatMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { runId: string; content: string; modelSlug?: string }) =>
      apiRequest("POST", `/api/chat/${data.runId}/messages`, data),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({
        queryKey: ["/api/chat", vars.runId, "messages"],
      });
    },
  });
}

export function useStandaloneChat() {
  return useMutation({
    mutationFn: (data: {
      content: string;
      modelSlug?: string;
      history?: Array<{ role: string; content: string }>;
    }) => apiRequest("POST", "/api/chat/standalone", data),
  });
}

// ─── Gateway ────────────────────────────────────

export function useGatewayStatus() {
  return useQuery({
    queryKey: ["/api/gateway/status"],
    queryFn: () => apiRequest("GET", "/api/gateway/status"),
  });
}

// ─── Provider Discovery ─────────────────────────

export function useDiscoverProviderModels() {
  return useQuery({
    queryKey: ["/api/providers/discover"],
    queryFn: () => apiRequest("GET", "/api/providers/discover"),
    refetchOnWindowFocus: false,
  });
}

export function useProbeEndpoint() {
  return useMutation({
    mutationFn: (data: { endpoint: string; providerType: "vllm" | "ollama" }) =>
      apiRequest("POST", "/api/providers/probe", data),
  });
}

export function useImportModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      slug: string;
      provider: string;
      endpoint: string | null;
      contextLimit: number;
      capabilities: string[];
      isActive: boolean;
    }) => apiRequest("POST", "/api/models", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/models"] });
    },
  });
}

export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/models/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/models"] });
    },
  });
}

// ─── Approval Gates ─────────────────────────────

export function useApproveStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, stageIndex, approvedBy }: { runId: string; stageIndex: number; approvedBy?: string }) =>
      apiRequest("POST", `/api/runs/${runId}/stages/${stageIndex}/approve`, { approvedBy }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["/api/runs", vars.runId] });
    },
  });
}

export function useRejectStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, stageIndex, reason }: { runId: string; stageIndex: number; reason?: string }) =>
      apiRequest("POST", `/api/runs/${runId}/stages/${stageIndex}/reject`, { reason }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["/api/runs", vars.runId] });
    },
  });
}

// ─── Export ─────────────────────────────────────

export function useExportRun() {
  return useMutation({
    mutationFn: async ({ runId, format }: { runId: string; format: "markdown" | "zip" }) => {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`/api/runs/${runId}/export?format=${format}`, { headers });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(errText || res.statusText);
      }
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] ?? (format === "zip" ? "export.zip" : "report.md");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

// ─── Specialization Profiles (Phase 5) ──────────────────────────────────────

export function useSpecializationProfiles() {
  return useQuery({
    queryKey: ["/api/specialization-profiles"],
    queryFn: () => apiRequest("GET", "/api/specialization-profiles"),
  });
}

export function useCreateSpecializationProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; assignments: Record<string, string> }) =>
      apiRequest("POST", "/api/specialization-profiles", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/specialization-profiles"] });
    },
  });
}

export function useDeleteSpecializationProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/specialization-profiles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/specialization-profiles"] });
    },
  });
}

// ─── Run Comparison (Phase 5) ─────────────────────────────────────────────────

export function useRunComparison(runId1: string, runId2: string) {
  return useQuery({
    queryKey: ["/api/runs/compare", runId1, runId2],
    queryFn: () => apiRequest("GET", `/api/runs/compare?runIds=${runId1},${runId2}`),
    enabled: !!runId1 && !!runId2,
  });
}


// ─── Manager Config (Phase 6.6) ───────────────────────────────────────────────

export interface ManagerConfig {
  managerModel: string;
  availableTeams: string[];
  maxIterations: number;
  goal: string;
}

export function useSetManagerConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pipelineId, config }: { pipelineId: string; config: ManagerConfig }) =>
      apiRequest("PATCH", `/api/pipelines/${pipelineId}/manager-config`, config),
    onSuccess: (_data, { pipelineId }) => {
      qc.invalidateQueries({ queryKey: ["/api/pipelines", pipelineId] });
      qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
    },
  });
}

export function useDeleteManagerConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pipelineId: string) =>
      apiRequest("DELETE", `/api/pipelines/${pipelineId}/manager-config`),
    onSuccess: (_data, pipelineId) => {
      qc.invalidateQueries({ queryKey: ["/api/pipelines", pipelineId] });
      qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
    },
  });
}

// ─── Swarm Config ────────────────────────────────────────────────────────────

import type { SwarmConfig, SwarmCloneResult, SwarmResult } from "@shared/types";

export function useSetSwarmConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      pipelineId,
      stageIndex,
      config,
    }: {
      pipelineId: string;
      stageIndex: number;
      config: SwarmConfig;
    }) =>
      apiRequest(
        "PATCH",
        `/api/pipelines/${pipelineId}/stages/${stageIndex}/swarm`,
        config,
      ),
    onSuccess: (_data, { pipelineId }) => {
      qc.invalidateQueries({ queryKey: ["/api/pipelines", pipelineId] });
      qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
    },
  });
}

export function useDeleteSwarmConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      pipelineId,
      stageIndex,
    }: {
      pipelineId: string;
      stageIndex: number;
    }) =>
      apiRequest(
        "DELETE",
        `/api/pipelines/${pipelineId}/stages/${stageIndex}/swarm`,
      ),
    onSuccess: (_data, { pipelineId }) => {
      qc.invalidateQueries({ queryKey: ["/api/pipelines", pipelineId] });
      qc.invalidateQueries({ queryKey: ["/api/pipelines"] });
    },
  });
}

export function useSwarmResults(runId: string, stageIndex: number) {
  return useQuery<{ swarmMeta: SwarmResult; cloneResults: SwarmCloneResult[] }>({
    queryKey: ["/api/runs", runId, "stages", stageIndex, "swarm-results"],
    queryFn: () =>
      apiRequest("GET", `/api/runs/${runId}/stages/${stageIndex}/swarm-results`),
    enabled: Boolean(runId),
    retry: false,
  });
}
