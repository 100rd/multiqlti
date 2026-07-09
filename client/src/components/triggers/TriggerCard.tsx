import { useState } from "react";
import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  Pencil, Trash2, Zap, Clock, Github, Gitlab, FolderSearch,
  ChevronRight, ChevronDown, GitPullRequest, ArrowUpRight, AlertTriangle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useEnableTrigger, useDisableTrigger, useTriggerLoops } from "@/hooks/use-triggers";
import type { Trigger, TriggerType, TriggerFiredLoop } from "@shared/types";
import { configSummary, loopTargetSummary } from "./trigger-form-logic";

// ─── Type badge config ────────────────────────────────────────────────────────

const TYPE_META: Record<TriggerType, { label: string; className: string; Icon: React.FC<{ className?: string }> }> = {
  webhook: {
    label: "Webhook",
    className: "bg-violet-500/15 text-violet-600 border-violet-500/30",
    Icon: Zap,
  },
  schedule: {
    label: "Schedule",
    className: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    Icon: Clock,
  },
  github_event: {
    label: "GitHub Event",
    className: "bg-gray-500/15 text-gray-700 border-gray-500/30",
    Icon: Github,
  },
  gitlab_event: {
    label: "GitLab Event",
    className: "bg-orange-500/15 text-orange-700 border-orange-500/30",
    Icon: Gitlab,
  },
  file_change: {
    label: "File Change",
    className: "bg-amber-500/15 text-amber-700 border-amber-500/30",
    Icon: FolderSearch,
  },
  tracker_event: {
    label: "GitHub Issues",
    className: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
    Icon: Github,
  },
};

// ─── Fired-loop helpers ───────────────────────────────────────────────────────

/** Safe relative time — returns null for a missing/unparseable instant. */
function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return formatDistanceToNow(new Date(ms), { addSuffix: true });
}

/** First 7 chars of a PR ref/commit-ish for a compact "hash" chip. */
function shortRef(ref: string | null): string | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  return trimmed.length > 12 ? trimmed.slice(0, 12) + "…" : trimmed;
}

/** One row in the expandable fired-loop list — clicking opens ConsiliumLoopDetail. */
function FiredLoopRow({ loop, onOpen }: { loop: TriggerFiredLoop; onOpen: (id: string) => void }) {
  const when = relativeTime(loop.firedAt);
  const pr = shortRef(loop.prRef);
  const label = loop.eventSummary ?? `Loop ${loop.loopId.slice(0, 8)}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(loop.loopId)}
      className="w-full text-left rounded-md border border-border/60 hover:border-border hover:bg-muted/50 px-2.5 py-2 transition-colors group"
      aria-label={`Open fired loop ${loop.loopId}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0 font-mono">
          {loop.state}
        </Badge>
        <span className="text-[11px] truncate flex-1 min-w-0">{label}</span>
        <ArrowUpRight className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
      </div>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground font-mono">
        {pr && (
          <span className="inline-flex items-center gap-1">
            <GitPullRequest className="h-2.5 w-2.5" />
            {pr}
          </span>
        )}
        <span className="inline-flex items-center gap-1" title={loop.eventDigest}>
          #{loop.eventDigest}
        </span>
        {when && <span>· {when}</span>}
      </div>
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface TriggerCardProps {
  trigger: Trigger;
  onEdit: (trigger: Trigger) => void;
  onDelete: (trigger: Trigger) => void;
}

export function TriggerCard({ trigger, onEdit, onDelete }: TriggerCardProps) {
  const enable = useEnableTrigger();
  const disable = useDisableTrigger();
  const [, navigate] = useLocation();
  const [expanded, setExpanded] = useState(false);

  // The loops this trigger actually fired (newest first) + the total fire count.
  const { data: fired, isLoading: firedLoading } = useTriggerLoops(trigger.id);

  const meta = TYPE_META[trigger.type];
  const Icon = meta.Icon;
  const isPending = enable.isPending || disable.isPending;
  const loopTarget = loopTargetSummary(trigger);

  function handleToggle(checked: boolean) {
    if (checked) {
      enable.mutate(trigger.id);
    } else {
      disable.mutate(trigger.id);
    }
  }

  const firedCount = fired?.firedCount ?? 0;
  const firedLoops = fired?.loops ?? [];
  const lastFired = firedLoops[0]; // newest first from the endpoint
  const hasFired = firedCount > 0;

  // Prefer the ACTUAL last-fire instant from the newest fired loop's provenance —
  // it is authoritative. `trigger.lastTriggeredAt` is a denormalised mirror the
  // firing path maintains; if it lags the real fire we flag it (rendering what is
  // there, per the firing-path/render split) rather than silently trusting it.
  const lastFireIso = lastFired?.firedAt ?? null;
  const lastFireRel = relativeTime(lastFireIso);
  const triggerStampRel = trigger.lastTriggeredAt
    ? formatDistanceToNow(new Date(trigger.lastTriggeredAt), { addSuffix: true })
    : null;
  // Stale iff we have a real fire but the trigger's own stamp is missing or older.
  const lastFireMs = lastFireIso ? Date.parse(lastFireIso) : NaN;
  const stampMs = trigger.lastTriggeredAt ? new Date(trigger.lastTriggeredAt).getTime() : NaN;
  const stampStale =
    hasFired && !Number.isNaN(lastFireMs) &&
    (Number.isNaN(stampMs) || stampMs < lastFireMs - 60_000);

  return (
    <Card className="border-border p-5">
      <div className="flex items-start justify-between gap-4">
        {/* Left: icon + info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <Icon className="h-4 w-4 text-primary" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className={`text-[10px] h-5 px-1.5 ${meta.className}`}
              >
                {meta.label}
              </Badge>
              {loopTarget && (
                <span className="text-[10px] text-muted-foreground font-medium truncate">
                  {loopTarget}
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground mt-1.5 font-mono truncate">
              {configSummary(trigger)}
            </p>

            {/* Fire counter (loops actually created) DISTINCT from suppressed. */}
            <p className="text-[10px] text-muted-foreground mt-1.5">
              {firedLoading && !fired ? (
                <span>Loading fire history…</span>
              ) : (
                <>
                  <span className="font-medium text-foreground">Fired {firedCount}</span>
                  {" · "}
                  <span className="font-medium">Suppressed {trigger.suppressedCount}</span>
                </>
              )}
            </p>

            {/* Last firing's event — from the newest fired loop's provenance. */}
            {hasFired && lastFired ? (
              <div className="mt-1.5 rounded-md bg-muted/40 border border-border/50 px-2.5 py-1.5">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Zap className="h-3 w-3 text-primary shrink-0" />
                  <span className="font-medium text-foreground">Last fire</span>
                  {lastFireRel && <span>· {lastFireRel}</span>}
                  {stampStale && (
                    <span
                      className="inline-flex items-center gap-0.5 text-amber-600"
                      title="The trigger's own lastTriggeredAt stamp is behind the newest fired loop — the firing path may not be advancing it."
                    >
                      <AlertTriangle className="h-2.5 w-2.5" /> stamp stale
                    </span>
                  )}
                </div>
                <p className="text-[11px] mt-0.5 truncate" title={lastFired.eventSummary ?? undefined}>
                  {lastFired.eventSummary ?? `Loop ${lastFired.loopId.slice(0, 8)}`}
                </p>
                <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground font-mono">
                  {shortRef(lastFired.prRef) && (
                    <span className="inline-flex items-center gap-1">
                      <GitPullRequest className="h-2.5 w-2.5" />
                      {shortRef(lastFired.prRef)}
                    </span>
                  )}
                  <span title="event digest">#{lastFired.eventDigest}</span>
                </div>
              </div>
            ) : (
              !firedLoading && (
                <p className="text-[10px] text-muted-foreground mt-1.5 italic">
                  Never fired
                  {triggerStampRel && !hasFired && (
                    <span className="not-italic"> · last checked {triggerStampRel}</span>
                  )}
                </p>
              )
            )}

            {/* Expandable list of fired loops → click a loop to open its detail. */}
            {hasFired && (
              <div className="mt-1.5">
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                  aria-expanded={expanded}
                  aria-label={expanded ? "Hide fired loops" : "Show fired loops"}
                >
                  {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {expanded ? "Hide" : "View"} fired loop{firedCount === 1 ? "" : "s"}
                  {firedCount > firedLoops.length && ` (showing ${firedLoops.length} of ${firedCount})`}
                </button>
                {expanded && (
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {firedLoops.map((loop) => (
                      <FiredLoopRow
                        key={loop.loopId}
                        loop={loop}
                        onOpen={(id) => navigate(`/consilium-loops/${id}`)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: toggle + actions */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <Switch
              id={`trigger-enabled-${trigger.id}`}
              checked={trigger.enabled}
              onCheckedChange={handleToggle}
              disabled={isPending}
              aria-label={trigger.enabled ? "Disable trigger" : "Enable trigger"}
            />
            <Label
              htmlFor={`trigger-enabled-${trigger.id}`}
              className="text-xs text-muted-foreground cursor-pointer"
            >
              {trigger.enabled ? "On" : "Off"}
            </Label>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onEdit(trigger)}
            aria-label="Edit trigger"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => onDelete(trigger)}
            aria-label="Delete trigger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
