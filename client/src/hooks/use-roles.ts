/**
 * use-roles.ts — React Query hooks for the ROLE-1 StandingRole surface
 * (standing-role.md §3/§8). Mirrors use-skills.ts but goes through the shared
 * `apiRequest` transport (use-pipeline) so every call carries auth + `x-project-id`
 * (the project-scoped `/api/roles` mount returns 401/400 without them).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/hooks/use-pipeline";
import type { StandingRoleRow } from "@shared/schema";
import type { StandingRoleLoopTemplate } from "@shared/types";

const ROLES_KEY = ["/api/roles"] as const;

// ─── Payload types ────────────────────────────────────────────────────────────

export interface CreateRolePayload {
  name: string;
  persona: string;
  skills: string[];
  loopTemplate: StandingRoleLoopTemplate;
  enabled?: boolean;
}

export type UpdateRolePayload = Partial<CreateRolePayload> & { id: string };

export interface WakeRolePayload {
  id: string;
  repoPath: string;
  focus: string;
}

// ─── Read hooks ─────────────────────────────────────────────────────────────

export function useRoles() {
  return useQuery<StandingRoleRow[]>({
    queryKey: ROLES_KEY,
    queryFn: () => apiRequest("GET", "/api/roles") as Promise<StandingRoleRow[]>,
  });
}

// ─── Mutation hooks ─────────────────────────────────────────────────────────

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation<StandingRoleRow, Error, CreateRolePayload>({
    mutationFn: (data) => apiRequest("POST", "/api/roles", data) as Promise<StandingRoleRow>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ROLES_KEY }),
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation<StandingRoleRow, Error, UpdateRolePayload>({
    mutationFn: ({ id, ...updates }) =>
      apiRequest("PATCH", `/api/roles/${id}`, updates) as Promise<StandingRoleRow>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ROLES_KEY }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation<null, Error, string>({
    mutationFn: (id) => apiRequest("DELETE", `/api/roles/${id}`) as Promise<null>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ROLES_KEY }),
  });
}

/**
 * Wake a role → spawns ONE ephemeral consilium loop. Resolves to the created loop
 * (the caller links to `/consilium-loops/:id`). Invalidates the loop list so the new
 * loop shows immediately.
 */
export function useWakeRole() {
  const qc = useQueryClient();
  return useMutation<{ id?: string } & Record<string, unknown>, Error, WakeRolePayload>({
    mutationFn: ({ id, repoPath, focus }) =>
      apiRequest("POST", `/api/roles/${id}/wake`, { repoPath, focus }) as Promise<
        { id?: string } & Record<string, unknown>
      >,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/consilium-loops"] }),
  });
}
