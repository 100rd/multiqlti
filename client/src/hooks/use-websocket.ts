import { useEffect, useState, useCallback, useRef } from "react";
import { wsClient } from "@/lib/websocket";
import type { WsEvent, StageStatus, RunStatus, SwarmCloneResult, SwarmMerger } from "@shared/types";

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

export interface SwarmStageState {
  cloneCount: number;
  cloneResults: Partial<SwarmCloneResult>[];
  isMerging: boolean;
  isCompleted: boolean;
  mergerUsed?: SwarmMerger;
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
  swarmStages: Map<string, SwarmStageState>;
}

export function usePipelineEvents(runId: string): PipelineEventState {
  const [state, setState] = useState<PipelineEventState>({
    status: "pending",
    stages: new Map(),
    currentStageIndex: 0,
    questions: [],
    messages: [],
    pendingApprovals: [],
    swarmStages: new Map(),
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

      case "swarm:started": {
        const stageId = event.payload.stageId as string;
        const swarmStages = new Map(s.swarmStages);
        swarmStages.set(stageId, {
          cloneCount: event.payload.cloneCount as number,
          cloneResults: [],
          isMerging: false,
          isCompleted: false,
        });
        setState({ ...s, swarmStages });
        break;
      }

      case "swarm:clone:started": {
        const stageId = event.payload.stageId as string;
        const swarmStages = new Map(s.swarmStages);
        const existing = swarmStages.get(stageId);
        if (existing) {
          const cloneIndex = event.payload.cloneIndex as number;
          const updated = existing.cloneResults.filter((r) => r.cloneIndex !== cloneIndex);
          swarmStages.set(stageId, {
            ...existing,
            cloneResults: [...updated, { cloneIndex, systemPromptPreview: event.payload.systemPromptPreview as string }],
          });
          setState({ ...s, swarmStages });
        }
        break;
      }

      case "swarm:clone:completed": {
        const stageId = event.payload.stageId as string;
        const swarmStages = new Map(s.swarmStages);
        const existing = swarmStages.get(stageId);
        if (existing) {
          const cloneIndex = event.payload.cloneIndex as number;
          const updated = existing.cloneResults.map((r) =>
            r.cloneIndex === cloneIndex
              ? { ...r, status: "succeeded" as const, tokensUsed: event.payload.tokensUsed as number }
              : r,
          );
          swarmStages.set(stageId, { ...existing, cloneResults: updated });
          setState({ ...s, swarmStages });
        }
        break;
      }

      case "swarm:clone:failed": {
        const stageId = event.payload.stageId as string;
        const swarmStages = new Map(s.swarmStages);
        const existing = swarmStages.get(stageId);
        if (existing) {
          const cloneIndex = event.payload.cloneIndex as number;
          const updated = existing.cloneResults.map((r) =>
            r.cloneIndex === cloneIndex
              ? { ...r, status: "failed" as const, error: event.payload.error as string }
              : r,
          );
          swarmStages.set(stageId, { ...existing, cloneResults: updated });
          setState({ ...s, swarmStages });
        }
        break;
      }

      case "swarm:merging": {
        const stageId = event.payload.stageId as string;
        const swarmStages = new Map(s.swarmStages);
        const existing = swarmStages.get(stageId);
        if (existing) {
          swarmStages.set(stageId, { ...existing, isMerging: true, mergerUsed: event.payload.strategy as SwarmMerger });
          setState({ ...s, swarmStages });
        }
        break;
      }

      case "swarm:completed": {
        const stageId = event.payload.stageId as string;
        const swarmStages = new Map(s.swarmStages);
        const existing = swarmStages.get(stageId);
        if (existing) {
          swarmStages.set(stageId, { ...existing, isMerging: false, isCompleted: true });
          setState({ ...s, swarmStages });
        }
        break;
      }
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
