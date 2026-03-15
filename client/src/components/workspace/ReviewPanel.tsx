import { cn } from "@/lib/utils";
import type { ReviewResult, ReviewIssue } from "@shared/types";

interface ReviewPanelProps {
  results: Record<string, ReviewResult>;
  isLoading?: boolean;
}

const severityConfig: Record<ReviewIssue["severity"], { label: string; classes: string }> = {
  error: { label: "Error", classes: "bg-red-500/10 text-red-500 border-red-500/20" },
  warning: { label: "Warn", classes: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  info: { label: "Info", classes: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
};

function SeverityBadge({ severity }: { severity: ReviewIssue["severity"] }) {
  const { label, classes } = severityConfig[severity];
  return (
    <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", classes)}>
      {label}
    </span>
  );
}

function IssueCard({ issue }: { issue: ReviewIssue }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2.5 space-y-1">
      <div className="flex items-start gap-2">
        <SeverityBadge severity={issue.severity} />
        <span className="text-xs text-muted-foreground font-mono">
          {issue.file}
          {issue.line ? `:${issue.line}` : ""}
        </span>
      </div>
      <p className="text-xs text-foreground">{issue.message}</p>
      {issue.suggestion && (
        <p className="text-[11px] text-muted-foreground italic">{issue.suggestion}</p>
      )}
    </div>
  );
}

function ModelReview({ result }: { result: ReviewResult }) {
  const errorCount = result.issues.filter((i) => i.severity === "error").length;
  const warnCount = result.issues.filter((i) => i.severity === "warning").length;
  const infoCount = result.issues.filter((i) => i.severity === "info").length;

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono font-semibold text-primary truncate">{result.model}</span>
        <div className="flex gap-1 shrink-0">
          {errorCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 font-semibold">
              {errorCount}E
            </span>
          )}
          {warnCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-semibold">
              {warnCount}W
            </span>
          )}
          {infoCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 font-semibold">
              {infoCount}I
            </span>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">{result.summary}</p>

      {result.issues.length > 0 && (
        <div className="space-y-1.5">
          {result.issues.map((issue, idx) => (
            <IssueCard key={idx} issue={issue} />
          ))}
        </div>
      )}

      {result.issues.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic">No issues found</p>
      )}
    </div>
  );
}

export function ReviewPanel({ results, isLoading }: ReviewPanelProps) {
  const entries = Object.values(results);

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-3 animate-pulse h-24" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="p-4 flex flex-col items-center justify-center h-32 text-center">
        <p className="text-xs text-muted-foreground">
          Select files and click "Review" to run multi-model code analysis.
        </p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3 overflow-y-auto">
      {entries.map((result) => (
        <ModelReview key={result.model} result={result} />
      ))}
    </div>
  );
}
