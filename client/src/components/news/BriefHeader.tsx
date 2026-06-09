/**
 * Morning Brief header: the day's date, brief status (generating / failed),
 * and a "Refresh now" action gated to maintainer/admin/owner.
 *
 * The header never throws on a missing brief; it degrades to the date alone.
 */
import { Newspaper, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Brief } from "@/hooks/use-news";

interface BriefHeaderProps {
  workspaceName?: string;
  brief: Brief | undefined;
  /** YYYY-MM-DD currently being viewed (falls back to brief date / today). */
  date: string;
  canRefresh: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
}

function formatBriefDate(value: string): string {
  // value is YYYY-MM-DD; parse as local date for display.
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function BriefHeader({
  workspaceName,
  brief,
  date,
  canRefresh,
  isRefreshing,
  onRefresh,
}: BriefHeaderProps) {
  const status = brief?.status;
  const generating = status === "generating";

  return (
    <header
      className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4"
      data-testid="brief-header"
      data-brief-status={status ?? "unknown"}
    >
      <Newspaper className="h-5 w-5 text-primary" />
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">Morning Brief</h1>
        <p className="text-sm text-muted-foreground">
          {formatBriefDate(date)}
          {workspaceName && (
            <span className="ml-1">
              · <span className="font-mono">{workspaceName}</span>
            </span>
          )}
        </p>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {generating && (
          <Badge
            variant="secondary"
            className="gap-1.5 text-xs"
            data-testid="brief-generating"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Generating your brief…
          </Badge>
        )}
        {status === "failed" && (
          <Badge variant="destructive" className="text-xs" data-testid="brief-failed">
            Generation failed
          </Badge>
        )}
        {canRefresh && (
          <Button
            onClick={onRefresh}
            disabled={isRefreshing || generating}
            size="sm"
            data-testid="refresh-now"
          >
            <RefreshCw className={isRefreshing ? "mr-2 h-4 w-4 animate-spin" : "mr-2 h-4 w-4"} />
            {isRefreshing ? "Refreshing…" : "Refresh now"}
          </Button>
        )}
      </div>
    </header>
  );
}
