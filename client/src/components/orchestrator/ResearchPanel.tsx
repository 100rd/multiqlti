/**
 * Research + grounding panel (read-only).
 *
 * Cited research findings (claim + snippet + an https-guarded sourceUrl link)
 * with per-query sources fetched / skipped counts, plus a grounding summary
 * derived from the `ground` step(s).
 *
 * SECURITY (C3 / M2):
 *  - claim, snippet, query, and sourceUrl are UNTRUSTED fetched content rendered
 *    as inert React text.
 *  - sourceUrl is only made a clickable anchor when `safeHttpsHref` proves it is
 *    an absolute https URL; the anchor carries target=_blank +
 *    rel="noopener noreferrer" and is never auto-followed. Otherwise the URL is
 *    shown as inert plain text.
 */
import { ExternalLink, BookOpen, ShieldCheck, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { safeHttpsHref, outputToText } from "@/lib/orchestrator";
import type {
  OrchestratorResearch,
  ResearchFinding,
  OrchestratorStep,
} from "@/lib/orchestrator";

interface ResearchPanelProps {
  research: OrchestratorResearch[];
  /** The `ground`-type steps, used to summarize grounded / degraded. */
  groundSteps: OrchestratorStep[];
}

export function ResearchPanel({ research, groundSteps }: ResearchPanelProps) {
  return (
    <Card data-testid="research-panel">
      <CardHeader>
        <CardTitle>Research &amp; grounding</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <GroundingSummary groundSteps={groundSteps} />

        {research.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="research-empty">
            No research in this run.
          </p>
        ) : (
          research.map((r) => <ResearchQuery key={r.id} research={r} />)
        )}
      </CardContent>
    </Card>
  );
}

function ResearchQuery({ research }: { research: OrchestratorResearch }) {
  return (
    <section className="rounded-lg border border-border" data-testid="research-query">
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 p-3">
        <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {/* Untrusted query — inert text. */}
        <p className="min-w-0 flex-1 text-sm font-medium break-words">{research.query}</p>
        <span
          className="text-xs tabular-nums text-muted-foreground"
          data-testid="research-counts"
        >
          {research.sourcesFetched} fetched · {research.sourcesSkipped} skipped
        </span>
      </header>

      <div className="divide-y divide-border/60">
        {research.findings.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No findings recorded.</p>
        ) : (
          research.findings.map((finding, i) => (
            <FindingRow key={i} finding={finding} />
          ))
        )}
      </div>
    </section>
  );
}

function FindingRow({ finding }: { finding: ResearchFinding }) {
  const href = safeHttpsHref(finding.sourceUrl);
  return (
    <div className="p-3" data-testid="research-finding">
      {/* Untrusted claim — inert text. */}
      <p className="text-sm font-medium leading-snug break-words">{finding.claim}</p>
      {/* Untrusted snippet — inert text, preserves newlines. */}
      {finding.snippet && (
        <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground break-words">
          {finding.snippet}
        </p>
      )}
      <div className="mt-2">
        <SourceLink uri={finding.sourceUrl} href={href} />
      </div>
    </div>
  );
}

/**
 * Renders the source URL: an https-guarded anchor when safe, otherwise the
 * literal URL as inert text. Never auto-followed; rel="noopener noreferrer".
 */
function SourceLink({ uri, href }: { uri: string; href: string | null }) {
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-1 truncate text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="research-source-link"
        title={href}
      >
        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{uri}</span>
      </a>
    );
  }
  // Non-https / unparseable: inert plain text, NOT a link.
  return (
    <span
      className="block truncate text-xs text-muted-foreground"
      data-testid="research-source-unlinked"
      title="Source is not an https URL — shown as text, not linked"
    >
      {uri}
    </span>
  );
}

function GroundingSummary({ groundSteps }: { groundSteps: OrchestratorStep[] }) {
  const completed = groundSteps.filter((s) => s.status === "completed");
  if (groundSteps.length === 0) return null;

  // The ground step output may include a `degraded` flag; treat anything that
  // failed or is flagged degraded as degraded grounding.
  const anyDegraded = groundSteps.some((s) => {
    if (s.status === "failed") return true;
    const text = outputToText(s.output).toLowerCase();
    return text.includes('"degraded":true') || text.includes("degraded: true");
  });

  const grounded = completed.length > 0 && !anyDegraded;

  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm"
      role="note"
      data-testid="grounding-summary"
      data-grounded={grounded}
    >
      {grounded ? (
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
      ) : (
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      )}
      <p className="text-muted-foreground">
        {grounded
          ? "Claims were grounded against fetched sources."
          : "Grounding degraded — some claims could not be verified against sources."}
      </p>
    </div>
  );
}
