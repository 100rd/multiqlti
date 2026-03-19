import { useState, useEffect, useCallback, useRef } from "react";
import { wsClient } from "@/lib/websocket";
import type { WsEvent } from "@shared/types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TaskEventInfo {
  name: string;
  status: string;
  executionMode?: string;
  modelSlug?: string;
  summary?: string;
  error?: string;
  pipelineRunId?: string;
  dependsOn?: string[];
  artifacts?: unknown[];
  decisions?: string[];
}

export interface ActivityEntry {
  type: string;
  taskId?: string;
  taskName?: string;
  message: string;
  timestamp: string;
}

export interface TaskGroupEventState {
  groupStatus: string;
  tasks: Map<string, TaskEventInfo>;
  activity: ActivityEntry[];
  completedCount: number;
  totalCount: number;
  runningCount: number;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useTaskGroupEvents(groupId: string): TaskGroupEventState {
  const [state, setState] = useState<TaskGroupEventState>({
    groupStatus: "pending",
    tasks: new Map(),
    activity: [],
    completedCount: 0,
    totalCount: 0,
    runningCount: 0,
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  const addActivity = (s: TaskGroupEventState, entry: Omit<ActivityEntry, "timestamp">, timestamp: string): ActivityEntry[] => {
    return [...s.activity, { ...entry, timestamp }];
  };

  const handleEvent = useCallback((event: WsEvent) => {
    if (event.runId !== groupId) return;
    const s = stateRef.current;
    const p = event.payload;

    switch (event.type) {
      case "task:created": {
        const tasks = new Map(s.tasks);
        tasks.set(p.taskId as string, {
          name: p.name as string,
          status: p.status as string,
          dependsOn: p.dependsOn as string[],
        });
        setState({
          ...s,
          tasks,
          totalCount: tasks.size,
        });
        break;
      }

      case "task:ready": {
        const tasks = new Map(s.tasks);
        const existing = tasks.get(p.taskId as string);
        if (existing) tasks.set(p.taskId as string, { ...existing, status: "ready" });
        setState({
          ...s,
          tasks,
          activity: addActivity(s, {
            type: "task:ready",
            taskId: p.taskId as string,
            taskName: p.name as string,
            message: `Task "${p.name}" is ready to start`,
          }, event.timestamp),
        });
        break;
      }

      case "task:started": {
        const tasks = new Map(s.tasks);
        const existing = tasks.get(p.taskId as string);
        tasks.set(p.taskId as string, {
          ...(existing ?? { name: p.name as string }),
          name: p.name as string,
          status: "running",
          executionMode: p.executionMode as string,
          modelSlug: p.modelSlug as string | undefined,
        });
        setState({
          ...s,
          tasks,
          runningCount: s.runningCount + 1,
          activity: addActivity(s, {
            type: "task:started",
            taskId: p.taskId as string,
            taskName: p.name as string,
            message: `Started "${p.name}" (${p.executionMode}${p.modelSlug ? ` / ${p.modelSlug}` : ""})`,
          }, event.timestamp),
        });
        break;
      }

      case "task:progress": {
        setState({
          ...s,
          activity: addActivity(s, {
            type: "task:progress",
            taskId: p.taskId as string,
            taskName: p.name as string | undefined,
            message: p.message as string,
          }, event.timestamp),
        });
        break;
      }

      case "task:completed": {
        const tasks = new Map(s.tasks);
        const existing = tasks.get(p.taskId as string);
        tasks.set(p.taskId as string, {
          ...(existing ?? { name: p.name as string }),
          name: p.name as string,
          status: "completed",
          summary: p.summary as string,
          artifacts: p.artifacts as unknown[] | undefined,
          decisions: p.decisions as string[] | undefined,
        });
        const newCompleted = s.completedCount + 1;
        setState({
          ...s,
          tasks,
          completedCount: newCompleted,
          runningCount: Math.max(0, s.runningCount - 1),
          activity: addActivity(s, {
            type: "task:completed",
            taskId: p.taskId as string,
            taskName: p.name as string,
            message: `Completed "${p.name}": ${p.summary}`,
          }, event.timestamp),
        });
        break;
      }

      case "task:failed": {
        const tasks = new Map(s.tasks);
        const existing = tasks.get(p.taskId as string);
        tasks.set(p.taskId as string, {
          ...(existing ?? { name: p.name as string }),
          name: p.name as string,
          status: "failed",
          error: p.error as string,
        });
        setState({
          ...s,
          tasks,
          runningCount: Math.max(0, s.runningCount - 1),
          activity: addActivity(s, {
            type: "task:failed",
            taskId: p.taskId as string,
            taskName: p.name as string,
            message: `Failed "${p.name}": ${p.error}`,
          }, event.timestamp),
        });
        break;
      }

      case "taskgroup:started":
        setState({
          ...s,
          groupStatus: "running",
          totalCount: p.totalTasks as number,
          activity: addActivity(s, {
            type: "taskgroup:started",
            message: `Task group started — ${p.totalTasks} tasks, ${p.readyTasks} ready`,
          }, event.timestamp),
        });
        break;

      case "taskgroup:progress":
        setState({
          ...s,
          completedCount: p.completed as number,
          runningCount: p.running as number,
        });
        break;

      case "taskgroup:completed":
        setState({
          ...s,
          groupStatus: "completed",
          activity: addActivity(s, {
            type: "taskgroup:completed",
            message: `All tasks completed (${p.completedTasks}/${p.totalTasks})`,
          }, event.timestamp),
        });
        break;

      case "taskgroup:failed":
        setState({
          ...s,
          groupStatus: "failed",
          activity: addActivity(s, {
            type: "taskgroup:failed",
            message: `Task group failed: ${p.error}`,
          }, event.timestamp),
        });
        break;
    }
  }, [groupId]);

  useEffect(() => {
    wsClient.connect();
    wsClient.subscribe(groupId);
    const unsub = wsClient.onAny(handleEvent);

    return () => {
      unsub();
      wsClient.unsubscribe(groupId);
    };
  }, [groupId, handleEvent]);

  return state;
}
