import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  WorkspaceConnection,
  CreateWorkspaceConnectionInput,
  UpdateWorkspaceConnectionInput,
} from "@shared/types";

// ─── Auth helper ──────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest(method: string, url: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as {
      message?: string;
      error?: string;
    };
    const message = err.message ?? err.error ?? res.statusText;
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }

  if (res.status === 204) return null;
  return res.json();
}

// ─── Query keys ───────────────────────────────────────────────────────────────

export function connectionsKey(workspaceId: string) {
  return ["/api/workspaces", workspaceId, "connections"] as const;
}

export function connectionKey(workspaceId: string, cid: string) {
  return ["/api/workspaces", workspaceId, "connections", cid] as const;
}

// ─── Test result shape ────────────────────────────────────────────────────────

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number | null;
  details: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useConnections(workspaceId: string) {
  return useQuery<WorkspaceConnection[]>({
    queryKey: connectionsKey(workspaceId),
    queryFn: () =>
      apiRequest("GET", `/api/workspaces/${workspaceId}/connections`) as Promise<
        WorkspaceConnection[]
      >,
    enabled: !!workspaceId,
  });
}

export function useConnection(workspaceId: string, cid: string) {
  return useQuery<WorkspaceConnection>({
    queryKey: connectionKey(workspaceId, cid),
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/workspaces/${workspaceId}/connections/${cid}`,
      ) as Promise<WorkspaceConnection>,
    enabled: !!workspaceId && !!cid,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateConnection(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<
    WorkspaceConnection,
    Error,
    Omit<CreateWorkspaceConnectionInput, "workspaceId">
  >({
    mutationFn: (data) =>
      apiRequest("POST", `/api/workspaces/${workspaceId}/connections`, {
        ...data,
        workspaceId,
      }) as Promise<WorkspaceConnection>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionsKey(workspaceId) });
    },
  });
}

export function useUpdateConnection(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<
    WorkspaceConnection,
    Error,
    { cid: string } & UpdateWorkspaceConnectionInput
  >({
    mutationFn: ({ cid, ...updates }) =>
      apiRequest(
        "PATCH",
        `/api/workspaces/${workspaceId}/connections/${cid}`,
        updates,
      ) as Promise<WorkspaceConnection>,
    onSuccess: (_, { cid }) => {
      qc.invalidateQueries({ queryKey: connectionsKey(workspaceId) });
      qc.invalidateQueries({ queryKey: connectionKey(workspaceId, cid) });
    },
  });
}

export function useDeleteConnection(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<null, Error, string>({
    mutationFn: (cid) =>
      apiRequest(
        "DELETE",
        `/api/workspaces/${workspaceId}/connections/${cid}`,
      ) as Promise<null>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionsKey(workspaceId) });
    },
  });
}

export function useTestConnection(workspaceId: string) {
  return useMutation<ConnectionTestResult, Error, string>({
    mutationFn: (cid) =>
      apiRequest(
        "POST",
        `/api/workspaces/${workspaceId}/connections/${cid}/test`,
      ) as Promise<ConnectionTestResult>,
  });
}
