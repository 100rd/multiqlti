/**
 * CurrentRunsRail — the left rail on the Pipelines page listing the actual
 * pipeline RUNS (not definitions). This is where action points handed off from
 * a planning verdict (VerdictPanel → "Hand off to pipeline") show up once they
 * start executing.
 *
 * Active runs (running / queued / paused) float to the top; finished runs follow
 * by recency. Clicking a run opens its detail at /runs/:id.
 *
 * SECURITY: run-derived text (title/source) is rendered as INERT React text.
 */
import { useMemo } from "react";
import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { useRuns } from "@/hooks/use-pipeline";
import { useToast } from "@/hooks/use-toast";
import { copyText } from "@/lib/clipboard";
import { Loader2, Activity } from "lucide-react";

interface PipelineRun {
  id: string;
  pipelineId: string;
  status: string;
  input: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

const STATUS: Record<string, { dot: string; label: string; text: string }> = {
  running: { dot: "bg-blue-500 animate-pulse", label: "running", text: "text-blue-600 dark:text-blue-400" },
  queued: { dot: "bg-amber-500", label: "queued", text: "text-amber-600 dark:text-amber-400" },
  paused: { dot: "bg-violet-500", label: "paused", text: "text-violet-600 dark:text-violet-400" },
  completed: { dot: "bg-green-500", label: "done", text: "text-green-600 dark:text-green-400" },
  failed: { dot: "bg-red-500", label: "failed", text: "text-red-600 dark:text-red-400" },
  cancelled: { dot: "bg-slate-400", label: "cancelled", text: "text-muted-foreground" },
};

const ACTIVE = new Set(["running", "queued", "paused"]);

/** A run's display title: handoff runs store JSON input ({feature,source,…}). */
function runTitle(input: string | null): string {
  if (!input) return "Pipeline run";
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    const feature = typeof o.feature === "string" ? o.feature : "";
    if (feature) return feature;
  } catch {
    /* plain-string input — fall through */
  }
  return input.slice(0, 80);
}

function runSource(input: string | null): string | null {
  if (!input) return null;
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    return typeof o.source === "string" && o.source ? o.source : null;
  } catch {
    return null;
  }
}

function whenLabel(run: PipelineRun): string {
  const ts = run.startedAt ?? run.createdAt;
  if (!ts) return "";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "";
  }
}

export function CurrentRunsRail({
  pipelineNames,
}: {
  pipelineNames: Record<string, string>;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  // Standalone live list → opt into a light poll as a WS backstop.
  const { data, isLoading } = useRuns(undefined, { refetchInterval: 5000 });

  async function copyId(e: React.MouseEvent, id: string) {
    e.stopPropagation(); // don't navigate when copying
    if (await copyText(id)) {
      toast({ title: "ID copied", description: id });
    } else {
      toast({ variant: "destructive", title: "Couldn't copy ID" });
    }
  }

  const runs = useMemo(() => {
    const list = (Array.isArray(data) ? data : []) as PipelineRun[];
    return [...list].sort((a, b) => {
      const aActive = ACTIVE.has(a.status) ? 0 : 1;
      const bActive = ACTIVE.has(b.status) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const at = new Date(a.startedAt ?? a.createdAt ?? 0).getTime();
      const bt = new Date(b.startedAt ?? b.createdAt ?? 0).getTime();
      return bt - at;
    });
  }, [data]);

  const activeCount = runs.filter((r) => ACTIVE.has(r.status)).length;

  return (
    <aside className="w-72 shrink-0 border-r border-border bg-card/40 flex flex-col h-full">
      <div className="h-16 border-b border-border flex items-center gap-2 px-4 shrink-0">
        <Activity className="h-4 w-4 text-primary" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">Current pipelines</h3>
          <p className="text-[11px] text-muted-foreground">
            {activeCount > 0 ? `${activeCount} active` : "Pipeline runs"}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-10 text-muted-foreground text-xs gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        )}

        {!isLoading && runs.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-xs text-muted-foreground">No active runs</p>
            <p className="text-[11px] text-muted-foreground/70 mt-1">
              Hand off action points from a planning verdict to the pipeline —
              runs will show up here.
            </p>
          </div>
        )}

        <ul className="divide-y divide-border">
          {runs.map((run) => {
            const st = STATUS[run.status] ?? {
              dot: "bg-muted-foreground",
              label: run.status,
              text: "text-muted-foreground",
            };
            const source = runSource(run.input);
            return (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/runs/${run.id}`)}
                  className="w-full text-left px-4 py-3 hover:bg-accent/40 transition-colors focus:outline-none focus:bg-accent/40"
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${st.dot}`} />
                    <span className={`text-[10px] font-medium uppercase tracking-wide ${st.text}`}>
                      {st.label}
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => copyId(e, run.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") copyId(e as unknown as React.MouseEvent, run.id);
                      }}
                      title={`${run.id} — click to copy`}
                      className="font-mono text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      #{run.id.slice(0, 8)}
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                      {whenLabel(run)}
                    </span>
                  </div>
                  <p className="text-xs font-medium mt-1 line-clamp-2">{runTitle(run.input)}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                    {pipelineNames[run.pipelineId] ?? run.pipelineId.slice(0, 8)}
                    {source ? ` · ${source}` : ""}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
