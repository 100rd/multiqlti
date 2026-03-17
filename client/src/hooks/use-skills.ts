import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Skill, InsertSkill } from "@shared/schema";

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function apiRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
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
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error((err as { message?: string }).message ?? res.statusText);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

// ─── Query Key Factories ──────────────────────────────────────────────────────

export interface SkillFilter {
  teamId?: string;
  isBuiltin?: boolean;
}

function skillsKey(filter?: SkillFilter): unknown[] {
  if (!filter || (filter.teamId === undefined && filter.isBuiltin === undefined)) {
    return ["/api/skills"];
  }
  return ["/api/skills", filter];
}

function buildSkillsUrl(filter?: SkillFilter): string {
  const params = new URLSearchParams();
  if (filter?.teamId !== undefined) params.set("teamId", filter.teamId);
  if (filter?.isBuiltin !== undefined) params.set("isBuiltin", String(filter.isBuiltin));
  const qs = params.toString();
  return qs ? `/api/skills?${qs}` : "/api/skills";
}

// ─── Read Hooks ───────────────────────────────────────────────────────────────

export function useSkills(filter?: SkillFilter) {
  return useQuery<Skill[]>({
    queryKey: skillsKey(filter),
    queryFn: () => apiRequest<Skill[]>("GET", buildSkillsUrl(filter)),
  });
}

export function useSkill(id: string) {
  return useQuery<Skill>({
    queryKey: ["/api/skills", id],
    queryFn: () => apiRequest<Skill>("GET", `/api/skills/${id}`),
    enabled: Boolean(id),
  });
}

// ─── Mutation Payload Types ───────────────────────────────────────────────────

export type CreateSkillPayload = Pick<
  InsertSkill,
  | "name"
  | "description"
  | "teamId"
  | "systemPromptOverride"
  | "tools"
  | "modelPreference"
  | "outputSchema"
  | "tags"
  | "isPublic"
>;

export type UpdateSkillPayload = Partial<CreateSkillPayload> & { id: string };

export interface ImportSkillsPayload {
  skills: Partial<CreateSkillPayload>[];
  conflictStrategy: "skip" | "overwrite";
}

export interface ImportSkillsResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface ExportSkillsPayload {
  version: string;
  exportedAt: string;
  skills: Skill[];
}

// ─── Mutation Hooks ───────────────────────────────────────────────────────────

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation<Skill, Error, CreateSkillPayload>({
    mutationFn: (data) => apiRequest<Skill>("POST", "/api/skills", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
    },
  });
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation<Skill, Error, UpdateSkillPayload>({
    mutationFn: ({ id, ...updates }) =>
      apiRequest<Skill>("PATCH", `/api/skills/${id}`, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation<null, Error, string>({
    mutationFn: (id) => apiRequest<null>("DELETE", `/api/skills/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
    },
  });
}

export function useImportSkills() {
  const qc = useQueryClient();
  return useMutation<ImportSkillsResult, Error, ImportSkillsPayload>({
    mutationFn: (payload) =>
      apiRequest<ImportSkillsResult>("POST", "/api/skills/import", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/skills"] });
    },
  });
}

/**
 * Export skills — fetches the export endpoint and triggers a browser file download.
 * Returns the parsed payload for callers that need to inspect it.
 */
export function useExportSkills() {
  return useMutation<ExportSkillsPayload, Error, void>({
    mutationFn: async () => {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch("/api/skills/export", { headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error((err as { message?: string }).message ?? res.statusText);
      }

      const payload = (await res.json()) as ExportSkillsPayload;

      // Trigger download in browser
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "skills-export.json";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      return payload;
    },
  });
}
