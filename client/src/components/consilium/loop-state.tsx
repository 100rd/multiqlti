/**
 * loop-state.tsx — shared presentation for ConsiliumLoopState: a state→chip-style
 * map (mirroring current-runs-rail.tsx's status palette) and an ordered FSM
 * lifecycle used by the detail-page stepper.
 *
 * P5 — `stopped_cap` is CONTEXT-AWARE. The same terminal state means different
 * things depending on the loop's intent, so `loopStateLabel(loop)` overrides the
 * static map for it (see the helper's doc). The static LOOP_STATE_STYLE map still
 * backs every non-contextual state, and the state-only LoopStateBadge/LoopStateChip
 * remain for callers that don't have the full loop row.
 *
 * SECURITY: pure presentation. No model-authored text passes through here.
 */
import { Badge } from "@/components/ui/badge";
import type { ConsiliumLoopState, ClientLoopState } from "@/hooks/use-consilium-loops";
import { isTerminalLoopState } from "@/hooks/use-consilium-loops";

interface StateStyle {
  /** Short human label. */
  label: string;
  /** A solid Badge className for the state pill. */
  badge: string;
  /** A dot class (rail style) for compact lists. */
  dot: string;
}

/** Never-crash fallback for a state token this map doesn't (yet) know about. */
const UNKNOWN_STATE_STYLE: StateStyle = {
  label: "Unknown",
  badge: "bg-slate-500 text-white",
  dot: "bg-slate-400",
};

export const LOOP_STATE_STYLE: Record<ClientLoopState, StateStyle> = {
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
  stopped: { label: "Finished", badge: "bg-slate-600 text-white", dot: "bg-slate-500" },
  // Agent-limit throttling (MVP): a deliberate, non-terminal PAUSE (agent usage/
  // rate limit hit) — amber like `awaiting_merge`, but the dot doesn't pulse
  // (nothing is actively running while paused) so it reads distinctly from the
  // "in progress" states.
  throttled: { label: "Throttled", badge: "bg-amber-500 text-black", dot: "bg-amber-500" },
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

/**
 * The minimal loop shape the context-aware label needs. Both the list item and
 * the detail row satisfy this structurally.
 */
export interface LoopStateContext {
  state: ClientLoopState;
  maxRounds: number;
  openP0: number | null;
}

/**
 * P5 — context-aware style + label. `stopped_cap` is the only contextual state
 * today; its meaning depends on the loop's INTENT, recovered from its fields:
 *
 *   • Assessment  (maxRounds === 1)            — a single dispute round, no
 *       remediation intended  → SUCCESS tone, "Completed — review".
 *   • Remediation at cap with unresolved P0s
 *       (maxRounds > 1 && openP0 > 0)          → STOP tone, "Stopped — {n} P0 open"
 *       (preserves the open-P0 signal that a plain "Stopped (cap)" would drop).
 *   • Otherwise (cap hit, no open P0s)         → static "Stopped (cap)".
 *
 * Every other state falls straight through to the static LOOP_STATE_STYLE map.
 */
export function loopStateLabel(loop: LoopStateContext): StateStyle {
  if (loop.state === "stopped_cap") {
    if (loop.maxRounds === 1) {
      return { label: "Completed — review", badge: "bg-green-600 text-white", dot: "bg-green-500" };
    }
    const open = loop.openP0 ?? 0;
    if (loop.maxRounds > 1 && open > 0) {
      return {
        label: `Stopped — ${open} P0 open`,
        badge: "bg-yellow-500 text-black",
        dot: "bg-yellow-500",
      };
    }
  }
  return LOOP_STATE_STYLE[loop.state] ?? UNKNOWN_STATE_STYLE;
}

// ─── State-only variants (no loop context available) ────────────────────────

export function LoopStateBadge({ state }: { state: ClientLoopState }) {
  const style = LOOP_STATE_STYLE[state] ?? UNKNOWN_STATE_STYLE;
  return <Badge className={style.badge}>{style.label}</Badge>;
}

/** Compact dot + label, matching the pipeline rail's chip style. */
export function LoopStateChip({ state }: { state: ClientLoopState }) {
  const style = LOOP_STATE_STYLE[state] ?? UNKNOWN_STATE_STYLE;
  return <ChipBody style={style} terminal={isTerminalLoopState(state)} />;
}

// ─── Context-aware variants (full loop row available) ───────────────────────

/** Badge whose terminal label/colour reflects the loop's intent (see loopStateLabel). */
export function LoopStateBadgeFor({ loop }: { loop: LoopStateContext }) {
  const style = loopStateLabel(loop);
  return <Badge className={style.badge}>{style.label}</Badge>;
}

/** Chip whose terminal label/colour reflects the loop's intent (see loopStateLabel). */
export function LoopStateChipFor({ loop }: { loop: LoopStateContext }) {
  const style = loopStateLabel(loop);
  return <ChipBody style={style} terminal={isTerminalLoopState(loop.state)} />;
}

function ChipBody({ style, terminal }: { style: StateStyle; terminal: boolean }) {
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
