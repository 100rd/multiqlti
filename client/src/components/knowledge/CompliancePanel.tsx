/**
 * Compliance panel — renders the thin compliance pass: for each accepted card,
 * which infra graph nodes follow, violate, or are unknown against it.
 *
 * Honesty (Security G4 / LOW):
 *  - `followed` is a COARSE substring heuristic — it MAY over-report. Labelled
 *    as such, never as a guarantee.
 *  - `violated` is empty in this thin MVP and is NEVER presented as an
 *    authoritative finding.
 *  - `unknown` dominates and is shown as the default, not a verdict.
 *
 * All node text (label / source_file) is unreviewed graph data and is rendered
 * as inert plain text only.
 */
import { useState } from "react";
import {
  ShieldCheck,
  ShieldX,
  HelpCircle,
  Info,
  FileQuestion,
  ChevronDown,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  useCompliance,
  type ComplianceNode,
  type ComplianceResult,
} from "@/hooks/use-practice-cards";
import {
  CardListSkeleton,
  QueryError,
  EmptyState,
  errorMessage,
} from "./QueryStates";

/** Best-effort display name for a graph node (label may be absent). */
function nodeLabel(n: ComplianceNode): string {
  return n.label ?? n.source_file ?? n.id;
}

export function CompliancePanel({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading, isError, error, refetch } = useCompliance(workspaceId);

  return (
    <div className="space-y-4">
      <div
        className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        role="note"
      >
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Compliance maps accepted cards against your infra graph with a{" "}
          <strong>coarse substring heuristic</strong>. &ldquo;Followed&rdquo; may
          over-report and is not a guarantee; &ldquo;violated&rdquo; is not
          computed in this MVP (always empty). Most nodes read as{" "}
          <strong>unknown</strong> — that is expected and is never treated as a
          verdict.
        </p>
      </div>

      {isLoading ? (
        <CardListSkeleton rows={3} />
      ) : isError ? (
        <QueryError message={errorMessage(error)} onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<FileQuestion className="h-10 w-10" />}
          title="No compliance results"
          description="Compliance runs against accepted cards. Accept cards in the review queue to populate this view."
        />
      ) : (
        <ul className="space-y-2" data-testid="compliance-results">
          {data.map((result) => (
            <ComplianceRow key={result.cardId} result={result} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ComplianceRow({ result }: { result: ComplianceResult }) {
  const [open, setOpen] = useState(false);
  const followed = result.followed.length;
  const violated = result.violated.length;
  const unknown = result.unknown.length;

  return (
    <li
      className="rounded-lg border border-border"
      data-testid="compliance-row"
      data-card-id={result.cardId}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-sm font-medium leading-snug line-clamp-2">
          {result.statement}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <CountBadge
            tone="emerald"
            icon={<ShieldCheck className="h-3 w-3" />}
            count={followed}
            label="likely followed (heuristic)"
          />
          <CountBadge
            tone="muted"
            icon={<HelpCircle className="h-3 w-3" />}
            count={unknown}
            label="unknown"
          />
          {violated > 0 && (
            <CountBadge
              tone="destructive"
              icon={<ShieldX className="h-3 w-3" />}
              count={violated}
              label="flagged (not authoritative)"
            />
          )}
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3">
          <NodeGroup
            label="Likely followed"
            hint="Coarse substring match — may over-report"
            tone="emerald"
            nodes={result.followed}
          />
          <NodeGroup
            label="Unknown"
            hint="Heuristic could not determine"
            tone="muted"
            nodes={result.unknown}
          />
          <NodeGroup
            label="Flagged"
            hint="Not computed in this MVP — not authoritative"
            tone="destructive"
            nodes={result.violated}
          />
        </div>
      )}
    </li>
  );
}

const COUNT_TONE: Record<string, string> = {
  emerald: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  destructive: "bg-destructive/10 text-destructive border-destructive/30",
  muted: "bg-muted text-muted-foreground border-border",
};

function CountBadge({
  tone,
  icon,
  count,
  label,
}: {
  tone: string;
  icon: React.ReactNode;
  count: number;
  label: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-xs tabular-nums", COUNT_TONE[tone])}
      title={label}
      aria-label={`${count} ${label}`}
    >
      {icon}
      {count}
    </Badge>
  );
}

function NodeGroup({
  label,
  hint,
  tone,
  nodes,
}: {
  label: string;
  hint: string;
  tone: string;
  nodes: ComplianceNode[];
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label} ({nodes.length})
        <span className="ml-1 normal-case font-normal opacity-70">· {hint}</span>
      </p>
      {nodes.length === 0 ? (
        <p className="text-xs text-muted-foreground">None</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {nodes.map((n) => (
            <li key={n.id}>
              <Badge
                variant="outline"
                className={cn("text-xs font-mono", COUNT_TONE[tone])}
                title={n.source_file ?? n.id}
              >
                {nodeLabel(n)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
