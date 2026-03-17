import { RefreshCw, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkspaceIndexStatus } from "@/hooks/useWorkspaceSocket";

// ─── Props ────────────────────────────────────────────────────────────────────

interface IndexStatusBadgeProps {
  status: WorkspaceIndexStatus;
  onTrigger?: () => void;
  disabled?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function IndexStatusBadge({ status, onTrigger, disabled }: IndexStatusBadgeProps) {
  if (status === "indexing") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 font-medium">
        <RefreshCw className="h-2.5 w-2.5 animate-spin" />
        Indexing...
      </span>
    );
  }

  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-500 font-medium">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Indexed
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px]">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 font-medium">
          <AlertCircle className="h-2.5 w-2.5" />
          Index failed
        </span>
        {onTrigger && (
          <button
            onClick={onTrigger}
            disabled={disabled}
            className={cn(
              "px-1.5 py-0.5 rounded border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors",
              disabled && "opacity-50 cursor-not-allowed",
            )}
          >
            Retry
          </button>
        )}
      </span>
    );
  }

  // idle
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px]">
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
        <Clock className="h-2.5 w-2.5" />
        Not indexed
      </span>
      {onTrigger && (
        <button
          onClick={onTrigger}
          disabled={disabled}
          className={cn(
            "px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          Index Now
        </button>
      )}
    </span>
  );
}
