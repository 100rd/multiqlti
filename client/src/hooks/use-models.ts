import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./use-api";

// ─── Models ─────────────────────────────────────

export function useModels() {
  return useQuery({
    queryKey: ["/api/models"],
    queryFn: () => apiRequest("GET", "/api/models"),
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

export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/models/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/models"] });
    },
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
