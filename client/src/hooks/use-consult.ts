import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./use-api";

/** Mirrors the server's ConsultSession row (dates arrive as ISO strings). */
export interface ConsultSessionDto {
  id: string;
  projectId: string;
  question: string;
  modelSlugs: string[];
  status: "created" | "answered" | "debated" | "handed_off";
  createdBy: string;
  createdAt: string;
  loopId: string | null;
  workspaceId: string | null;
}

export interface ConsultAnswerDto {
  id: string;
  sessionId: string;
  modelSlug: string;
  round: number;
  content: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface ConsultRoundResult {
  round: number;
  answers: ConsultAnswerDto[];
}

const LIST_KEY = ["/api/consult"] as const;

export function useConsultSessions() {
  return useQuery<{ sessions: ConsultSessionDto[] }>({
    queryKey: LIST_KEY,
    queryFn: () => apiRequest("GET", "/api/consult"),
  });
}

export function useConsultSession(id: string | null) {
  return useQuery<{ session: ConsultSessionDto; answers: ConsultAnswerDto[] }>({
    queryKey: ["/api/consult", id],
    queryFn: () => apiRequest("GET", `/api/consult/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateConsult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { question: string; modelSlugs: string[] }) =>
      apiRequest("POST", "/api/consult", data) as Promise<ConsultSessionDto>,
    onSuccess: () => qc.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

/** Invalidate both the session detail and the history list after a mutation. */
function invalidateSession(qc: ReturnType<typeof useQueryClient>, sessionId: string) {
  qc.invalidateQueries({ queryKey: ["/api/consult", sessionId] });
  qc.invalidateQueries({ queryKey: LIST_KEY });
}

export function useConsultAnswer(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/consult/${sessionId}/answer`, {}) as Promise<ConsultRoundResult>,
    onSuccess: () => invalidateSession(qc, sessionId),
  });
}

export function useConsultDebate(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/consult/${sessionId}/debate`, {}) as Promise<ConsultRoundResult>,
    onSuccess: () => invalidateSession(qc, sessionId),
  });
}

export function useConsultHandoff(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { repoPath: string; instruction: string }) =>
      apiRequest("POST", `/api/consult/${sessionId}/handoff`, data) as Promise<{
        loopId: string;
        workspaceId: string;
      }>,
    onSuccess: () => invalidateSession(qc, sessionId),
  });
}
