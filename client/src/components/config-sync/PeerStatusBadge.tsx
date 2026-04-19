/**
 * PeerStatusBadge.tsx — Header badge showing config-sync peer status.
 *
 * Issue #324: Config sync UI — peer status indicator
 *
 * States:
 *   green  — all peers synced within 5 min
 *   yellow — synced but ≥1 peer has a pending queue
 *   red    — any peer offline OR unresolved conflicts
 *
 * Shows: "3 peers, synced 2m ago"
 */

import { Link } from "wouter";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useConfigSyncStatus,
  type SyncBadgeState,
  formatLastSeen,
} from "@/hooks/use-config-sync";
import { cn } from "@/lib/utils";
import { Network, WifiOff, AlertTriangle } from "lucide-react";

// ─── Colour maps ──────────────────────────────────────────────────────────────

const BADGE_CLASSES: Record<SyncBadgeState, string> = {
  green: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  yellow: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  red: "bg-red-500/15 text-red-600 border-red-500/30",
};

const DOT_CLASSES: Record<SyncBadgeState, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
};

function StateIcon({ state }: { state: SyncBadgeState }) {
  if (state === "red") return <WifiOff className="h-3 w-3" />;
  if (state === "yellow") return <AlertTriangle className="h-3 w-3" />;
  return <Network className="h-3 w-3" />;
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface PeerStatusBadgeProps {
  /** When true the badge links to the config sync page on click. */
  asLink?: boolean;
  className?: string;
}

export function PeerStatusBadge({ asLink = true, className }: PeerStatusBadgeProps) {
  const { data: status, isLoading, isError } = useConfigSyncStatus();

  // While loading or when federation is not enabled, render nothing.
  if (isLoading || isError || !status) return null;
  if (status.totalPeers === 0) return null;

  const state = status.badgeState;

  const badge = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full border",
        BADGE_CLASSES[state],
        asLink && "cursor-pointer hover:opacity-80 transition-opacity",
        className,
      )}
      aria-label={`Config sync status: ${status.summary}`}
    >
      {/* Animated dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        {state !== "red" && (
          <span
            className={cn(
              "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
              DOT_CLASSES[state],
            )}
          />
        )}
        <span
          className={cn("relative inline-flex rounded-full h-2 w-2", DOT_CLASSES[state])}
        />
      </span>

      <StateIcon state={state} />
      <span>{status.summary}</span>

      {status.openConflicts > 0 && (
        <span className="ml-0.5 bg-red-500 text-white rounded-full px-1 text-[9px] font-bold">
          {status.openConflicts}
        </span>
      )}
    </span>
  );

  const tooltipContent = (
    <div className="space-y-1 max-w-xs">
      <p className="font-medium text-xs">{status.summary}</p>
      {status.peers.map((peer) => (
        <div key={peer.peerId} className="flex items-center justify-between gap-4 text-[11px]">
          <span className="font-mono truncate max-w-[120px]">{peer.peerName}</span>
          <span className="text-muted-foreground">
            {peer.lastSeenSecs !== null ? formatLastSeen(peer.lastSeenSecs) : "offline"}
            {peer.queueDepth > 0 && ` · queue: ${peer.queueDepth}`}
            {peer.openConflicts > 0 && ` · ${peer.openConflicts} conflict${peer.openConflicts !== 1 ? "s" : ""}`}
          </span>
        </div>
      ))}
      {status.openConflicts > 0 && (
        <p className="text-red-500 text-[11px] font-medium mt-1">
          {status.openConflicts} unresolved conflict{status.openConflicts !== 1 ? "s" : ""} require attention
        </p>
      )}
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {asLink ? (
          <Link href="/settings/peers">
            <a>{badge}</a>
          </Link>
        ) : (
          badge
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="p-2">
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  );
}
