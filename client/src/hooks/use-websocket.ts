import { useEffect, useState, useCallback, useRef } from "react";
import { wsClient } from "@/lib/websocket";
import type { WsEvent, StageStatus, RunStatus } from "@shared/types";

export function useWebSocket(runId?: string) {
  const [isConnected, setIsConnected] = useState(wsClient.isConnected);
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);

  useEffect(() => {
    wsClient.connect();

    const unsubAny = wsClient.onAny((event) => {
      setLastEvent(event);
      setIsConnected(wsClient.isConnected);
    });

    if (runId) {
      wsClient.subscribe(runId);
    }

    return () => {
      unsubAny();
      if (runId) wsClient.unsubscribe(runId);
    };
  }, [runId]);

  return { lastEvent, isConnected };
}

export interface PendingApproval {
  stageIndex: number;
  stageExecutionId: string;
  teamId: string;
}

export interface ParallelSubtaskState {
  subtaskId: string;
  title: string;
  modelSlug: string;
  status: "pending" | "running" | "completed" | "failed";
  tokensUsed?: number;
  durationMs?: number;
  output?: string;
  error?: string;
}

export interface ParallelStageState {
  stageIndex: number;
  subtasks: ParallelSubtaskState[];
  mergeStrategy: string;
  isMerging: boolean;
  mergedOutput?: Record<string, unknown>;
  splitReason?: string;
}

export interface PipelineEventState {
  status: RunStatus;
  stages: Map<
    number,
    {
      teamId: string;
      modelSlug: string;
      status: StageStatus;
      output?: Record<string, unknown>;
      tokensUsed?: number;
    }
  >;
  currentStageIndex: number;
  questions: Array<{
    id: string;
    question: string;
    context?: string;
    status: string;
    answer?: string;
  }>;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    agentTeam?: string;
  }>;
  pendingApprovals: PendingApproval[];
  parallelStages: Map<number, ParallelStageState>;
}

export function usePipelineEvents(runId: string): PipelineEventState {
  const [state, setState] = useState<PipelineEventState>({
    status: "pending",
    stages: new Map(),
    currentStageIndex: 0,
    questions: [],
    messages: [],
    pendingApprovals: [],
    parallelStages: new Map(),
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  const handleEvent = useCallback((event: WsEvent) => {
    if (event.runId !== runId) return;
    const s = stateRef.current;

    switch (event.type) {
      case "pipeline:started":
        setState({ ...s, status: "running" });
        break;

      case "pipeline:completed":
        setState({ ...s, status: "completed" });
        break;

      case "pipeline:failed":
        setState({ ...s, status: "failed" });
        break;

      case "pipeline:cancelled":
        setState({ ...s, status: "cancelled" });
        break;

      case "stage:started": {
        const stages = new Map(s.stages);
        const idx = event.payload.stageIndex as number;
        stages.set(idx, {
          teamId: event.payload.teamId as string,
          modelSlug: event.payload.modelSlug as string,
          status: "running",
        });
        setState({ ...s, stages, currentStageIndex: idx, status: "running" });
        break;
      }

      case "stage:completed": {
        const stages = new Map(s.stages);
        const idx = event.payload.stageIndex as number;
        const existing = stages.get(idx);
        stages.set(idx, {
          teamId: existing?.teamId ?? (event.payload.teamId as string),
          modelSlug: existing?.modelSlug ?? "",
          status: "completed",
          output: event.payload.output as Record<string, unknown>,
          tokensUsed: event.payload.tokensUsed as number,
        });
        setState({ ...s, stages });
        break;
      }

      case "stage:failed": {
        const stages = new Map(s.stages);
        const idx = event.payload.stageIndex as number;
        const existing = stages.get(idx);
        stages.set(idx, {
          teamId: existing?.teamId ?? "",
          modelSlug: existing?.modelSlug ?? "",
          status: "failed",
        });
        setState({ ...s, stages });
        break;
      }

      case "stage:awaiting_approval": {
        const stageIndex = event.payload.stageIndex as number;
        const stages = new Map(s.stages);
        const existing = stages.get(stageIndex);
        stages.set(stageIndex, {
          teamId: existing?.teamId ?? (event.payload.teamId as string),
          modelSlug: existing?.modelSlug ?? "",
          status: "awaiting_approval",
          output: existing?.output,
          tokensUsed: existing?.tokensUsed,
        });
        const approval: PendingApproval = {
          stageIndex,
          stageExecutionId: event.stageExecutionId ?? "",
          teamId: event.payload.teamId as string,
        };
        setState({
          ...s,
          stages,
          status: "paused",
          pendingApprovals: [...s.pendingApprovals.filter((a) => a.stageIndex !== stageIndex), approval],
        });
        break;
      }

      case "stage:approved": {
        const stageIndex = event.payload.stageIndex as number;
        const stages = new Map(s.stages);
        const existing = stages.get(stageIndex);
        if (existing) {
          stages.set(stageIndex, { ...existing, status: "completed" });
        }
        setState({
          ...s,
          stages,
          status: "running",
          pendingApprovals: s.pendingApprovals.filter((a) => a.stageIndex !== stageIndex),
        });
        break;
      }

      case "stage:rejected": {
        const stageIndex = event.payload.stageIndex as number;
        const stages = new Map(s.stages);
        const existing = stages.get(stageIndex);
        if (existing) {
          stages.set(stageIndex, { ...existing, status: "failed" });
        }
        setState({
          ...s,
          stages,
          status: "rejected" as RunStatus,
          pendingApprovals: s.pendingApprovals.filter((a) => a.stageIndex !== stageIndex),
        });
        break;
      }

      // Phase 3.4: Auto-approve gate resolved
      case "stage:auto_approved":
      case "stage:timeout_approved": {
        const stageIndex = event.payload.stageIndex as number;
        const stages = new Map(s.stages);
        const existing = stages.get(stageIndex);
        if (existing) {
          stages.set(stageIndex, { ...existing, status: "completed" });
        }
        setState({
          ...s,
          stages,
          status: "running",
          pendingApprovals: s.pendingApprovals.filter((a) => a.stageIndex !== stageIndex),
        });
        break;
      }

      // Phase 3.4: Timeout rejection
      case "stage:timeout_rejected": {
        const stageIndex = event.payload.stageIndex as number;
        const stages = new Map(s.stages);
        const existing = stages.get(stageIndex);
        if (existing) {
          stages.set(stageIndex, { ...existing, status: "failed" });
        }
        setState({
          ...s,
          stages,
          status: "rejected" as RunStatus,
          pendingApprovals: s.pendingApprovals.filter((a) => a.stageIndex !== stageIndex),
        });
        break;
      }

      case "parallel:split": {
        const stageIndex = event.payload.stageIndex as number;
        const subtasks = (event.payload.subtasks as Array<{
          id: string;
          title: string;
          suggestedModel?: string;
        }>) ?? [];
        const parallelStages = new Map(s.parallelStages);
        parallelStages.set(stageIndex, {
          stageIndex,
          subtasks: subtasks.map((st) => ({
            subtaskId: st.id,
            title: st.title,
            modelSlug: st.suggestedModel ?? "",
            status: "pending",
          })),
          mergeStrategy: (event.payload.mergeStrategy as string) ?? "auto",
          isMerging: false,
          splitReason: event.payload.reason as string | undefined,
        });
        setState({ ...s, parallelStages });
        break;
      }

      case "parallel:subtask:started": {
        const stageIndex = event.payload.stageIndex as number;
        const subtaskId = event.payload.subtaskId as string;
        const modelSlug = event.payload.modelSlug as string;
        const parallelStages = new Map(s.parallelStages);
        const ps = parallelStages.get(stageIndex);
        if (ps) {
          parallelStages.set(stageIndex, {
            ...ps,
            subtasks: ps.subtasks.map((st) =>
              st.subtaskId === subtaskId
                ? { ...st, status: "running", modelSlug: modelSlug || st.modelSlug }
                : st,
            ),
          });
          setState({ ...s, parallelStages });
        }
        break;
      }

      case "parallel:subtask:completed": {
        const stageIndex = event.payload.stageIndex as number;
        const subtaskId = event.payload.subtaskId as string;
        const failed = (event.payload.error as string | undefined) !== undefined;
        const parallelStages = new Map(s.parallelStages);
        const ps = parallelStages.get(stageIndex);
        if (ps) {
          parallelStages.set(stageIndex, {
            ...ps,
            subtasks: ps.subtasks.map((st) =>
              st.subtaskId === subtaskId
                ? {
                    ...st,
                    status: failed ? "failed" : "completed",
                    tokensUsed: event.payload.tokensUsed as number | undefined,
                    durationMs: event.payload.durationMs as number | undefined,
                    output: event.payload.output as string | undefined,
                    error: event.payload.error as string | undefined,
                  }
                : st,
            ),
          });
          setState({ ...s, parallelStages });
        }
        break;
      }

      case "parallel:merged": {
        const stageIndex = event.payload.stageIndex as number;
        const parallelStages = new Map(s.parallelStages);
        const ps = parallelStages.get(stageIndex);
        if (ps) {
          parallelStages.set(stageIndex, {
            ...ps,
            isMerging: false,
            mergedOutput: event.payload.output as Record<string, unknown> | undefined,
          });
          setState({ ...s, parallelStages });
        }
        break;
      }

      case "question:asked":
        setState({
          ...s,
          status: "paused",
          questions: [
            ...s.questions,
            {
              id: event.payload.questionId as string,
              question: event.payload.question as string,
              context: event.payload.context as string | undefined,
              status: "pending",
            },
          ],
        });
        break;

      case "question:answered":
        setState({
          ...s,
          questions: s.questions.map((q) =>
            q.id === event.payload.questionId
              ? { ...q, status: "answered", answer: event.payload.answer as string }
              : q,
          ),
        });
        break;

      case "chat:message":
        setState({
          ...s,
          messages: [
            ...s.messages,
            {
              id: event.payload.messageId as string,
              role: event.payload.role as string,
              content: event.payload.content as string,
              agentTeam: event.payload.agentTeam as string | undefined,
            },
          ],
        });
        break;
    }
  }, [runId]);

  useEffect(() => {
    wsClient.connect();
    wsClient.subscribe(runId);
    const unsub = wsClient.onAny(handleEvent);

    return () => {
      unsub();
      wsClient.unsubscribe(runId);
    };
  }, [runId, handleEvent]);

  return state;
}
