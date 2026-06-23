/**
 * loop-state.tsx — shared presentation for ConsiliumLoopState: a state→chip-style
 * map (mirroring current-runs-rail.tsx's status palette) and an ordered FSM
 * lifecycle used by the detail-page stepper.
 *
 * SECURITY: pure presentation. No model-authored text passes through here.
 */
import { Badge } from "@/components/ui/badge";
import type { ConsiliumLoopState } from "@/hooks/use-consilium-loops";
import { isTerminalLoopState } from "@/hooks/use-consilium-loops";

interface StateStyle {
  /** Short human label. */
  label: string;
  /** A solid Badge className for the state pill. */
  badge: string;
  /** A dot class (rail style) for compact lists. */
  dot: string;
}

export const LOOP_STATE_STYLE: Record<ConsiliumLoopState, StateStyle> = {
  pending: { label: "Pending", badge: "bg-slate-500 text-white", dot: "bg-slate-400" },
  building_context: {
    label: "Building context",
    badge: "bg-blue-500 text-white",
    dot: "bg-blue-500 animate-pulse",
  },
  reviewing: {
    label: "Reviewing",
    badge: "bg-blue-500 text-white",
    dot: "bg-blue-500 animate-pulse",
  },
  deciding: {
    label: "Deciding",
    badge: "bg-indigo-500 text-white",
    dot: "bg-indigo-500 animate-pulse",
  },
  developing: {
    label: "Developing",
    badge: "bg-violet-500 text-white",
    dot: "bg-violet-500 animate-pulse",
  },
  awaiting_merge: {
    label: "Awaiting merge",
    badge: "bg-amber-500 text-black",
    dot: "bg-amber-500 animate-pulse",
  },
  converged: { label: "Converged", badge: "bg-green-600 text-white", dot: "bg-green-500" },
  stopped_cap: { label: "Stopped (cap)", badge: "bg-yellow-500 text-black", dot: "bg-yellow-500" },
  escalated: { label: "Escalated", badge: "bg-orange-500 text-white", dot: "bg-orange-500" },
  failed: { label: "Failed", badge: "bg-red-600 text-white", dot: "bg-red-500" },
  cancelled: { label: "Cancelled", badge: "bg-slate-400 text-white", dot: "bg-slate-400" },
};

/** The non-terminal lifecycle, in FSM order — drives the detail-page stepper. */
export const LOOP_LIFECYCLE: ConsiliumLoopState[] = [
  "pending",
  "building_context",
  "reviewing",
  "deciding",
  "developing",
  "awaiting_merge",
];

export function LoopStateBadge({ state }: { state: ConsiliumLoopState }) {
  const style = LOOP_STATE_STYLE[state];
  return <Badge className={style.badge}>{style.label}</Badge>;
}

/** Compact dot + label, matching the pipeline rail's chip style. */
export function LoopStateChip({ state }: { state: ConsiliumLoopState }) {
  const style = LOOP_STATE_STYLE[state];
  const terminal = isTerminalLoopState(state);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
      <span
        className={`text-[10px] font-medium uppercase tracking-wide ${
          terminal ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {style.label}
      </span>
    </span>
  );
}
