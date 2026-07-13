/**
 * use-credentials — create/rotate/edit/delete mutations for the project
 * credential (secrets) vault, mirroring the mutation + invalidation shape of
 * client/src/hooks/use-connections.ts but wired through the shared
 * lib/queryClient apiRequest helper (Bearer + x-project-id headers are
 * injected automatically by buildAuthHeaders).
 *
 * Reads are handled directly in CredentialAccess.tsx via useQuery — this file
 * only owns the write path.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useProjects } from "@/hooks/use-projects";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Credential metadata as returned by the broker API. The secret value is never included. */
export interface CredentialMetadata {
  id: string;
  projectId: string;
  name: string | null;
  provider: string;
  scope: string;
  description: string;
  hasSecret: boolean;
  version: number;
  createdAt?: string | null;
  rotatedAt?: string | null;
}

export interface CreateCredentialInput {
  name: string;
  value: string;
  /** ADR-003 §D3 typed delivery. Absent ⇒ "static" (server default). */
  type?: "static" | "aws" | "kubernetes";
  description?: string;
  scope?: string;
  provider?: string;
}

export interface UpdateCredentialInput {
  value?: string;
  description?: string;
  scope?: string;
  provider?: string;
}

// ── Query keys ────────────────────────────────────────────────────────────────

function credentialsKey(projectId: string | null) {
  return ["/api/credentials", projectId] as const;
}

function accessLogKeyPrefix(projectId: string | null) {
  return ["/api/credentials/access-log", projectId] as const;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function useCreateCredential() {
  const qc = useQueryClient();
  const { currentProject } = useProjects();
  const projectId = currentProject?.id ?? null;

  return useMutation<CredentialMetadata, Error, CreateCredentialInput>({
    mutationFn: async (input) => {
      const res = await apiRequest("POST", "/api/credentials", input);
      return (await res.json()) as CredentialMetadata;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: credentialsKey(projectId) });
      qc.invalidateQueries({ queryKey: accessLogKeyPrefix(projectId) });
    },
  });
}

export function useUpdateCredential() {
  const qc = useQueryClient();
  const { currentProject } = useProjects();
  const projectId = currentProject?.id ?? null;

  return useMutation<
    CredentialMetadata,
    Error,
    { id: string } & UpdateCredentialInput
  >({
    mutationFn: async ({ id, ...updates }) => {
      const res = await apiRequest("PATCH", `/api/credentials/${id}`, updates);
      return (await res.json()) as CredentialMetadata;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: credentialsKey(projectId) });
      qc.invalidateQueries({ queryKey: accessLogKeyPrefix(projectId) });
    },
  });
}

export function useDeleteCredential() {
  const qc = useQueryClient();
  const { currentProject } = useProjects();
  const projectId = currentProject?.id ?? null;

  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await apiRequest("DELETE", `/api/credentials/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: credentialsKey(projectId) });
      qc.invalidateQueries({ queryKey: accessLogKeyPrefix(projectId) });
    },
  });
}
