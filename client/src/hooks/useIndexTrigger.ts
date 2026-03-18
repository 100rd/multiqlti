import { useMutation, useQueryClient } from "@tanstack/react-query";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IndexTriggerResponse {
  workspaceId: string;
  indexStatus: "indexing";
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function triggerIndex(workspaceId: string): Promise<IndexTriggerResponse> {
  const token = getAuthToken();
  const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`/api/workspaces/${workspaceId}/index`, {
    method: "POST",
    headers: authHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error((body as { error: string }).error ?? "Request failed");
  }
  return res.json() as Promise<IndexTriggerResponse>;
}

export function useIndexTrigger(workspaceId: string) {
  const qc = useQueryClient();

  return useMutation<IndexTriggerResponse, Error>({
    mutationFn: () => triggerIndex(workspaceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
    },
  });
}
