/**
 * use-workspaces.ts — the active project's workspaces (`GET /api/workspaces`).
 *
 * Shared by the Consilium loop LIST (group / filter by workspace name + seed the
 * New-review dialog) and the loop DETAIL (label the loop with its workspace).
 * Uses the shared `apiRequest` transport so `x-project-id` is attached, exactly
 * like every other project-scoped query.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/hooks/use-api";
import type { WorkspaceRow } from "@shared/schema";

export function useWorkspaces() {
  return useQuery<WorkspaceRow[]>({
    queryKey: ["/api/workspaces"],
    queryFn: () => apiRequest("GET", "/api/workspaces"),
  });
}
