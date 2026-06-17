import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./use-pipeline";

// ─── Status-aware error ───────────────────────────────────────────────────────
// The edit routes return 409 (non-pending / running) and 400 (cycle / dangling
// dependency). The shared apiRequest() collapses everything to Error(message),
// which loses the status the edit UI needs to phrase the inline message. This
// small request keeps the HTTP status on a typed error so callers can branch.

export class TaskGroupApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TaskGroupApiError";
    this.status = status;
  }
}

function authHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  const token = localStorage.getItem("auth_token");
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** Like apiRequest, but throws a TaskGroupApiError carrying the HTTP status. */
async function editRequest(
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: authHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    const parsed = (await res
      .json()
      .catch(() => ({ message: res.statusText }))) as {
      message?: string;
      error?: string;
    };
    throw new TaskGroupApiError(
      res.status,
      parsed.message ?? parsed.error ?? res.statusText,
    );
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Translate an edit error into the inline message the UI shows. 409 = the group
 * left the editable window (running, or input-after-terminal); 400 = the graph
 * is invalid (cycle / dangling / self dependency). Anything else surfaces the
 * server message verbatim.
 */
export function editErrorMessage(error: unknown): string {
  if (error instanceof TaskGroupApiError) {
    if (error.status === 409) {
      return error.message || "Can't edit a running or completed group.";
    }
    if (error.status === 400) {
      return (
        error.message ||
        "Invalid task graph (dependency cycle or dangling reference)."
      );
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

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
        // COPY-IN provenance (§5.3): when present the server re-copies the
        // template's fields into the new definition and stamps tasks.template_id.
        templateId?: string;
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

// ─── Edit mutations (status-aware; invalidate the group query) ─────────────────

/** PATCH the group's own fields. `input` is rejected (409) once terminal. */
export interface UpdateTaskGroupInput {
  name?: string;
  description?: string;
  input?: string;
}

export function useUpdateTaskGroup(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateTaskGroupInput) =>
      editRequest("PATCH", `/api/task-groups/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups", id] });
      qc.invalidateQueries({ queryKey: ["/api/task-groups"] });
    },
  });
}

/** PATCH a single task. dependsOn is keyed by task id. 409 non-pending, 400 cycle. */
export interface UpdateTaskInput {
  name?: string;
  description?: string;
  executionMode?: "pipeline_run" | "direct_llm";
  dependsOn?: string[];
  modelSlug?: string | null;
  teamId?: string | null;
  pipelineId?: string | null;
  sortOrder?: number;
}

export function useUpdateTask(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, ...data }: { taskId: string } & UpdateTaskInput) =>
      editRequest("PATCH", `/api/task-groups/${groupId}/tasks/${taskId}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups", groupId] });
    },
  });
}

/** POST a new task to a pending group. */
export interface AddTaskInput {
  name: string;
  description: string;
  executionMode?: "pipeline_run" | "direct_llm";
  dependsOn?: string[];
  modelSlug?: string | null;
  teamId?: string | null;
  pipelineId?: string | null;
  sortOrder?: number;
  /** COPY-IN provenance (§5.3): seed this task from a library template. */
  templateId?: string;
}

export function useAddTask(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: AddTaskInput) =>
      editRequest("POST", `/api/task-groups/${groupId}/tasks`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups", groupId] });
    },
  });
}

/** DELETE a task; the server strips its id from siblings' dependsOn. */
export function useDeleteTask(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      editRequest("DELETE", `/api/task-groups/${groupId}/tasks/${taskId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/task-groups", groupId] });
    },
  });
}
