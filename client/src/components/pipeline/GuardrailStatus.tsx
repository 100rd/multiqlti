/**
 * GuardrailStatus — real-time guardrail validation status shown during pipeline run.
 *
 * Subscribes to WS events guardrail:checking / guardrail:passed / guardrail:failed /
 * guardrail:retrying to update in real time.
 */
import { useEffect, useReducer } from "react";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GuardrailResult } from "@shared/types";

// ─── WS event payloads (subset) ──────────────────────────────────────────────

interface GuardrailWsEvent {
  type: string;
  payload: {
    stageId?: string;
    guardrailId?: string;
    action?: string;
    attempt?: number;
  };
}

// ─── State ───────────────────────────────────────────────────────────────────

type GuardrailState = "checking" | "passed" | "failed" | "retrying";

interface GuardrailEntry {
  guardrailId: string;
  state: GuardrailState;
  action?: string;
  attempt?: number;
}

type Action =
  | { type: "checking"; guardrailId: string }
  | { type: "passed"; guardrailId: string }
  | { type: "failed"; guardrailId: string; action?: string; attempt?: number }
  | { type: "retrying"; guardrailId: string; attempt?: number }
  | { type: "reset" };

function reducer(state: GuardrailEntry[], action: Action): GuardrailEntry[] {
  if (action.type === "reset") return [];

  const existing = state.find((g) => g.guardrailId === action.guardrailId);

  const updated: GuardrailEntry =
    action.type === "checking"
      ? { guardrailId: action.guardrailId, state: "checking" }
      : action.type === "passed"
        ? { guardrailId: action.guardrailId, state: "passed" }
        : action.type === "failed"
          ? { guardrailId: action.guardrailId, state: "failed", action: action.action, attempt: action.attempt }
          : { guardrailId: action.guardrailId, state: "retrying", attempt: action.attempt };

  if (existing) {
    return state.map((g) => (g.guardrailId === action.guardrailId ? updated : g));
  }
  return [...state, updated];
}

// ─── GuardrailStatus ─────────────────────────────────────────────────────────

interface GuardrailStatusProps {
  stageId: string;
  guardrailResults?: GuardrailResult[];
  wsEvents?: GuardrailWsEvent[];
  className?: string;
}

export default function GuardrailStatus({
  stageId,
  guardrailResults,
  wsEvents = [],
  className,
}: GuardrailStatusProps) {
  const [liveEntries, dispatch] = useReducer(reducer, []);

  // Process incoming WS events filtered to this stage
  useEffect(() => {
    const lastEvent = wsEvents[wsEvents.length - 1];
    if (!lastEvent) return;
    if (lastEvent.payload.stageId !== stageId) return;

    const { guardrailId, action, attempt } = lastEvent.payload;
    if (!guardrailId) return;

    switch (lastEvent.type) {
      case "guardrail:checking":
        dispatch({ type: "checking", guardrailId });
        break;
      case "guardrail:passed":
        dispatch({ type: "passed", guardrailId });
        break;
      case "guardrail:failed":
        dispatch({ type: "failed", guardrailId, action, attempt });
        break;
      case "guardrail:retrying":
        dispatch({ type: "retrying", guardrailId, attempt });
        break;
    }
  }, [wsEvents, stageId]);

  // If we have persisted results and no live activity, display from results
  const hasLiveActivity = liveEntries.length > 0;

  if (!hasLiveActivity && (!guardrailResults || guardrailResults.length === 0)) {
    return null;
  }

  // When stage is completed, render from stored results
  if (!hasLiveActivity && guardrailResults && guardrailResults.length > 0) {
    const passed = guardrailResults.filter((r) => r.passed).length;
    const total = guardrailResults.length;
    const allPassed = passed === total;

    return (
      <div className={cn("flex flex-wrap items-center gap-2 text-[10px]", className)}>
        <span className={cn("font-medium", allPassed ? "text-emerald-500" : "text-red-500")}>
          Guardrails: {passed}/{total} {allPassed ? "passed" : "failed"}
        </span>
        {guardrailResults.map((r) => (
          <span
            key={r.guardrailId}
            className={cn(
              "flex items-center gap-0.5",
              r.passed ? "text-emerald-500" : "text-red-500",
            )}
          >
            {r.passed ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            {r.guardrailId}
          </span>
        ))}
      </div>
    );
  }

  // Live / in-progress view
  const passedCount = liveEntries.filter((g) => g.state === "passed").length;
  const failedCount = liveEntries.filter((g) => g.state === "failed").length;
  const total = liveEntries.length;

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-[10px]", className)}>
      {failedCount > 0 ? (
        <span className="font-medium text-red-500">
          Guardrails: {failedCount} failed
        </span>
      ) : (
        <span className="font-medium text-muted-foreground">
          Guardrails: {passedCount}/{total} passed
        </span>
      )}

      {liveEntries.map((entry) => (
        <span
          key={entry.guardrailId}
          className={cn(
            "flex items-center gap-0.5",
            entry.state === "passed" && "text-emerald-500",
            entry.state === "failed" && "text-red-500",
            (entry.state === "checking" || entry.state === "retrying") && "text-muted-foreground",
          )}
        >
          {entry.state === "passed" && <CheckCircle2 className="h-3 w-3" />}
          {entry.state === "failed" && <XCircle className="h-3 w-3" />}
          {(entry.state === "checking" || entry.state === "retrying") && (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          {entry.guardrailId}
          {entry.state === "retrying" && entry.attempt !== undefined && (
            <span className="text-amber-500 ml-0.5">retrying ({entry.attempt}/{2})</span>
          )}
          {entry.state === "failed" && entry.action && (
            <span className="text-red-400 ml-0.5">→ {entry.action}</span>
          )}
        </span>
      ))}
    </div>
  );
}
