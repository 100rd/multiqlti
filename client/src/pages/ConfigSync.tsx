/**
 * ConfigSync.tsx — Config-sync peers list + conflict resolution panel.
 *
 * Issue #324: Config sync UI — peer status indicator + conflict panel
 *
 * Route: /settings/peers
 *
 * Sections:
 *  1. Peers overview table — name, last seen, queue depth, last sync, per-peer status
 *  2. Conflict panel       — unresolved conflicts with diff view + accept/keep buttons
 */

import { useState, useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Network,
  WifiOff,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Loader2,
  GitMerge,
  Clock,
  ShieldAlert,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useConfigSyncStatus,
  useConfigConflicts,
  useResolveConflict,
  useDismissConflict,
  useConfigSyncWsUpdates,
  formatLastSeen,
  type PeerSyncInfo,
  type ConfigConflict,
  type SyncBadgeState,
} from "@/hooks/use-config-sync";
import { useQueryClient } from "@tanstack/react-query";
import { CONFIG_SYNC_STATUS_KEY, CONFIG_CONFLICTS_KEY } from "@/hooks/use-config-sync";

// ─── Colour helpers ───────────────────────────────────────────────────────────

const BADGE_VARIANT: Record<SyncBadgeState, string> = {
  green: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  yellow: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  red: "bg-red-500/15 text-red-600 border-red-500/30",
};

function peerBadgeState(peer: PeerSyncInfo): SyncBadgeState {
  if (peer.status === "offline") return "red";
  if (peer.openConflicts > 0) return "red";
  if (peer.lastSeenSecs !== null && peer.lastSeenSecs > 300) return "red";
  if (peer.queueDepth > 0) return "yellow";
  return "green";
}

// ─── Peer row ─────────────────────────────────────────────────────────────────

function PeerRow({ peer }: { peer: PeerSyncInfo }) {
  const [expanded, setExpanded] = useState(false);
  const state = peerBadgeState(peer);

  return (
    <>
      <tr
        className={cn(
          "border-b border-border hover:bg-muted/30 transition-colors cursor-pointer",
          expanded && "bg-muted/20",
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="py-3 px-4">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="font-medium text-sm">{peer.peerName}</span>
            <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px] hidden sm:inline">
              {peer.endpoint}
            </span>
          </div>
        </td>
        <td className="py-3 px-4">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full border",
              BADGE_VARIANT[state],
            )}
          >
            {state === "green" && <CheckCircle2 className="h-3 w-3" />}
            {state === "yellow" && <AlertTriangle className="h-3 w-3" />}
            {state === "red" && <WifiOff className="h-3 w-3" />}
            {peer.status}
          </span>
        </td>
        <td className="py-3 px-4 text-sm text-muted-foreground">
          {peer.lastSeenSecs !== null ? formatLastSeen(peer.lastSeenSecs) : "—"}
        </td>
        <td className="py-3 px-4 text-sm">
          {peer.queueDepth > 0 ? (
            <span className="text-amber-600 font-medium">{peer.queueDepth}</span>
          ) : (
            <span className="text-muted-foreground">0</span>
          )}
        </td>
        <td className="py-3 px-4 text-sm">
          {peer.openConflicts > 0 ? (
            <span className="text-red-600 font-medium">{peer.openConflicts}</span>
          ) : (
            <span className="text-muted-foreground">0</span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="bg-muted/10">
          <td colSpan={5} className="px-8 py-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
              <div>
                <p className="text-muted-foreground">Peer ID</p>
                <p className="font-mono mt-0.5 break-all">{peer.peerId}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Endpoint</p>
                <p className="font-mono mt-0.5 break-all">{peer.endpoint}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Last seen</p>
                <p className="mt-0.5">
                  {peer.lastSeenSecs !== null ? formatLastSeen(peer.lastSeenSecs) : "Never"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Queue / Conflicts</p>
                <p className="mt-0.5">{peer.queueDepth} pending · {peer.openConflicts} conflicts</p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Diff block ───────────────────────────────────────────────────────────────

function PayloadDiff({
  local,
  remote,
}: {
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
}) {
  const localStr = JSON.stringify(local, null, 2);
  const remoteStr = JSON.stringify(remote, null, 2);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          Local version
        </p>
        <pre className="text-[11px] font-mono bg-muted rounded p-3 overflow-x-auto max-h-40 whitespace-pre-wrap break-all">
          {localStr}
        </pre>
      </div>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 mb-1">
          Remote version
        </p>
        <pre className="text-[11px] font-mono bg-amber-500/5 border border-amber-500/20 rounded p-3 overflow-x-auto max-h-40 whitespace-pre-wrap break-all">
          {remoteStr}
        </pre>
      </div>
    </div>
  );
}

// ─── Conflict card ────────────────────────────────────────────────────────────

function ConflictCard({ conflict }: { conflict: ConfigConflict }) {
  const [showDiff, setShowDiff] = useState(false);
  const resolve = useResolveConflict();
  const dismiss = useDismissConflict();
  const isActing =
    (resolve.isPending && (resolve.variables as { conflictId: string })?.conflictId === conflict.id) ||
    (dismiss.isPending && (dismiss.variables as { conflictId: string })?.conflictId === conflict.id);

  const detectedAgo = useMemo(() => {
    const ms = Date.now() - new Date(conflict.detectedAt).getTime();
    return formatLastSeen(Math.floor(ms / 1000));
  }, [conflict.detectedAt]);

  const strategyLabel: Record<string, string> = {
    human: "Human review",
    lww: "Last-write-wins",
    auto_merge: "Auto-merge",
    approval_voting: "Approval voting",
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-[10px] font-mono">
              {conflict.entityKind}
            </Badge>
            <span className="text-sm font-medium font-mono truncate max-w-[240px]">
              {conflict.entityId}
            </span>
            {conflict.isContested && (
              <Badge className="text-[10px] bg-amber-500/15 text-amber-600 border-amber-500/30">
                Contested
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Detected {detectedAgo}
            </span>
            <span>Peer: {conflict.peerId}</span>
            <span>Strategy: {strategyLabel[conflict.strategy] ?? conflict.strategy}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs font-mono text-muted-foreground">
                local <span className="text-foreground">{conflict.localVersion.slice(0, 8)}</span>
                {" vs "}
                remote <span className="text-amber-600">{conflict.remoteVersion.slice(0, 8)}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="text-xs">local: {conflict.localVersion}</p>
              <p className="text-xs">remote: {conflict.remoteVersion}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Diff toggle */}
      <button
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setShowDiff((v) => !v)}
      >
        {showDiff ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        {showDiff ? "Hide" : "Show"} diff
      </button>

      {showDiff && (
        <PayloadDiff
          local={conflict.localPayload}
          remote={conflict.remotePayload}
        />
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-border">
        <Button
          size="sm"
          className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
          disabled={isActing}
          onClick={() =>
            resolve.mutate({ conflictId: conflict.id, applyRemote: false })
          }
        >
          {isActing && !resolve.variables?.applyRemote ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3 w-3 mr-1" />
          )}
          Keep local
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs border-amber-500/50 text-amber-700 hover:bg-amber-500/10"
          disabled={isActing}
          onClick={() =>
            resolve.mutate({ conflictId: conflict.id, applyRemote: true })
          }
        >
          {isActing && resolve.variables?.applyRemote ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <GitMerge className="h-3 w-3 mr-1" />
          )}
          Accept remote
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs text-muted-foreground ml-auto"
          disabled={isActing}
          onClick={() => dismiss.mutate({ conflictId: conflict.id })}
        >
          {dismiss.isPending && (dismiss.variables as { conflictId: string })?.conflictId === conflict.id ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : null}
          Dismiss
        </Button>
      </div>

      {/* Error feedback */}
      {resolve.isError && (resolve.variables as { conflictId: string })?.conflictId === conflict.id && (
        <p className="text-xs text-destructive">{(resolve.error as Error).message}</p>
      )}
      {dismiss.isError && (dismiss.variables as { conflictId: string })?.conflictId === conflict.id && (
        <p className="text-xs text-destructive">{(dismiss.error as Error).message}</p>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ConfigSync() {
  // Real-time WS invalidation
  useConfigSyncWsUpdates();

  const qc = useQueryClient();
  const { data: statusData, isLoading: statusLoading } = useConfigSyncStatus();
  const { data: conflictsData, isLoading: conflictsLoading } = useConfigConflicts();

  const peers = statusData?.peers ?? [];
  const conflicts = conflictsData?.conflicts ?? [];
  const openConflicts = conflicts.filter(
    (c) => c.status === "pending_human" || c.status === "detected",
  );

  function handleRefresh() {
    void qc.invalidateQueries({ queryKey: CONFIG_SYNC_STATUS_KEY });
    void qc.invalidateQueries({ queryKey: CONFIG_CONFLICTS_KEY });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-3">
          <Network className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Config Sync</h1>
          {statusData && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full border",
                BADGE_VARIANT[statusData.badgeState],
              )}
            >
              {statusData.summary}
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1.5"
          onClick={handleRefresh}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-5xl mx-auto p-6 space-y-6">

          {/* Status summary cards */}
          {statusData && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-border bg-card p-3 space-y-1">
                <p className="text-xs text-muted-foreground">Total peers</p>
                <p className="text-2xl font-bold">{statusData.totalPeers}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 space-y-1">
                <p className="text-xs text-muted-foreground">Synced</p>
                <p className="text-2xl font-bold text-emerald-600">{statusData.syncedPeers}</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 space-y-1">
                <p className="text-xs text-muted-foreground">Pending queue</p>
                <p className="text-2xl font-bold text-amber-600">
                  {peers.reduce((s, p) => s + p.queueDepth, 0)}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3 space-y-1">
                <p className="text-xs text-muted-foreground">Open conflicts</p>
                <p className={cn("text-2xl font-bold", statusData.openConflicts > 0 && "text-red-600")}>
                  {statusData.openConflicts}
                </p>
              </div>
            </div>
          )}

          {/* Tabs: Peers / Conflicts */}
          <Tabs defaultValue={openConflicts.length > 0 ? "conflicts" : "peers"}>
            <TabsList className="mb-4">
              <TabsTrigger value="peers" className="text-xs">
                Peers
                {peers.length > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                    {peers.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="conflicts" className="text-xs">
                Conflicts
                {openConflicts.length > 0 && (
                  <Badge className="ml-1.5 text-[10px] px-1.5 py-0 bg-red-500 text-white hover:bg-red-500">
                    {openConflicts.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            {/* ── Peers tab ──────────────────────────────────────────────── */}
            <TabsContent value="peers">
              {statusLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading peers…
                </div>
              ) : peers.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <Network className="h-10 w-10 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">No peers configured</p>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    Federation peers are configured via the{" "}
                    <code className="font-mono bg-muted px-1 rounded">FEDERATION_PEERS</code> environment
                    variable.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 text-xs text-muted-foreground uppercase tracking-wide">
                        <th className="text-left py-2.5 px-4 font-medium">Peer</th>
                        <th className="text-left py-2.5 px-4 font-medium">Status</th>
                        <th className="text-left py-2.5 px-4 font-medium">Last seen</th>
                        <th className="text-left py-2.5 px-4 font-medium">Queue</th>
                        <th className="text-left py-2.5 px-4 font-medium">Conflicts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {peers.map((peer) => (
                        <PeerRow key={peer.peerId} peer={peer} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </TabsContent>

            {/* ── Conflicts tab ─────────────────────────────────────────── */}
            <TabsContent value="conflicts">
              {conflictsLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading conflicts…
                </div>
              ) : openConflicts.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500/40" />
                  <p className="text-sm text-muted-foreground">No unresolved conflicts</p>
                  <p className="text-xs text-muted-foreground max-w-sm">
                    All config-sync entities are in agreement across peers.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldAlert className="h-3.5 w-3.5 text-red-500" />
                    <span>
                      {openConflicts.length} conflict{openConflicts.length !== 1 ? "s" : ""} require human
                      resolution. Use "Keep local" to preserve your version or "Accept remote" to apply
                      the peer version.
                    </span>
                  </div>
                  {openConflicts.map((conflict) => (
                    <ConflictCard key={conflict.id} conflict={conflict} />
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>

        </div>
      </ScrollArea>
    </div>
  );
}
