/**
 * Task Groups v2 — Task Library (template) hooks (FE1), mirroring use-task-groups:
 * a keyset list (`useTaskTemplates({ label })`) + create / update / delete
 * mutations that invalidate the list query. The list is owner-scoped server-side
 * (a non-admin only ever sees their own templates); `created_by` is admin-only.
 *
 * SECURITY: every template field is user-authored and rendered as INERT React
 * text by the consuming page — never via dangerouslySetInnerHTML.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./use-pipeline";

/** A library template row (server `TaskTemplateRow`; createdBy admin-only). */
export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  executionMode: "direct_llm" | "pipeline_run";
  pipelineId: string | null;
  modelSlug: string | null;
  teamId: string | null;
  input: Record<string, unknown>;
  labels: string[];
  /** ADMIN-ONLY (absent for non-admins). */
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TemplateListPage {
  items: TaskTemplate[];
  nextCursor: string | null;
}

/** The create/update payload (server stamps createdBy on create). */
export interface TaskTemplateInput {
  name: string;
  description: string;
  executionMode?: "direct_llm" | "pipeline_run";
  pipelineId?: string | null;
  modelSlug?: string | null;
  teamId?: string | null;
  input?: Record<string, unknown>;
  labels?: string[];
}

/** Build the `GET /api/task-templates` query string (label-filtered, clamped). */
export function buildTemplateQuery(params: { label?: string | null; limit?: number }): string {
  const search = new URLSearchParams();
  if (params.label && params.label.trim()) search.set("label", params.label.trim());
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    const clamped = Math.max(1, Math.min(100, Math.floor(params.limit)));
    search.set("limit", String(clamped));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export interface UseTaskTemplatesOptions {
  label?: string | null;
}

/** Owner-scoped template list, optionally filtered by a single label. */
export function useTaskTemplates(options: UseTaskTemplatesOptions = {}) {
  const label = options.label ?? null;
  return useQuery<TemplateListPage>({
    queryKey: ["/api/task-templates", label],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/task-templates${buildTemplateQuery({ label })}`,
      ) as Promise<TemplateListPage>,
    refetchOnWindowFocus: false,
  });
}

export function useCreateTaskTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: TaskTemplateInput) =>
      apiRequest("POST", "/api/task-templates", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-templates"] });
    },
  });
}

export function useUpdateTaskTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<TaskTemplateInput>) =>
      apiRequest("PATCH", `/api/task-templates/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-templates"] });
    },
  });
}

export function useDeleteTaskTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/task-templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-templates"] });
    },
  });
}
