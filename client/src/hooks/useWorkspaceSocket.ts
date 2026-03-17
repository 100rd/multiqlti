import { useEffect, useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { wsClient } from "@/lib/websocket";
import { toast } from "sonner";
import type { WsEvent } from "@shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkspaceIndexStatus = "idle" | "indexing" | "ready" | "error";

export interface IndexProgressState {
  indexStatus: WorkspaceIndexStatus;
  filesProcessed: number;
  totalFiles: number;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWorkspaceSocket(workspaceId: string): IndexProgressState {
  const qc = useQueryClient();

  const [state, setState] = useState<IndexProgressState>({
    indexStatus: "idle",
    filesProcessed: 0,
    totalFiles: 0,
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  const handleEvent = useCallback(
    (event: WsEvent) => {
      const payload = event.payload as Record<string, unknown>;
      if (payload["workspaceId"] !== workspaceId) return;

      switch (event.type) {
        case "workspace:index_start":
          setState({
            indexStatus: "indexing",
            filesProcessed: 0,
            totalFiles: (payload["totalFiles"] as number) ?? 0,
          });
          break;

        case "workspace:index_progress":
          setState({
            ...stateRef.current,
            indexStatus: "indexing",
            filesProcessed: (payload["filesProcessed"] as number) ?? stateRef.current.filesProcessed,
            totalFiles: (payload["totalFiles"] as number) ?? stateRef.current.totalFiles,
          });
          break;

        case "workspace:index_complete":
          setState({
            indexStatus: "ready",
            filesProcessed: (payload["symbolCount"] as number) ?? stateRef.current.totalFiles,
            totalFiles: stateRef.current.totalFiles,
          });
          qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
          qc.invalidateQueries({ queryKey: ["dependency-graph", workspaceId] });
          qc.invalidateQueries({ queryKey: ["symbol-search", workspaceId] });
          toast.success("Workspace indexed successfully");
          break;

        case "workspace:index_error":
          setState({
            ...stateRef.current,
            indexStatus: "error",
          });
          toast.error("Indexing failed", {
            description: (payload["error"] as string) ?? "Unknown error",
          });
          break;
      }
    },
    [workspaceId, qc],
  );

  useEffect(() => {
    wsClient.connect();
    const unsub = wsClient.onAny(handleEvent);
    return () => unsub();
  }, [handleEvent]);

  return state;
}
