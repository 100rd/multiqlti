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
}

export function usePipelineEvents(runId: string): PipelineEventState {
  const [state, setState] = useState<PipelineEventState>({
    status: "pending",
    stages: new Map(),
    currentStageIndex: 0,
    questions: [],
    messages: [],
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
