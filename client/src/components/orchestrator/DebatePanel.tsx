/**
 * Debate transcript panel (read-only, collapsible).
 *
 * For each debate step: the question, a `degraded → Opus-only` badge when the
 * provider-diverse path fell back, the rounds (each turn's participant + role +
 * content), and the arbiter recommendation + confidence + dissent. Collapsed by
 * default; expand to read the transcript.
 *
 * SECURITY: every debate string (question, turn content, recommendation,
 * dissent, verdict) is UNTRUSTED model output rendered as inert React text.
 */
import { useState } from "react";
import { ChevronDown, ShieldAlert, Gavel } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { groupDebateRounds, toPercent } from "@/lib/orchestrator";
import type { OrchestratorDebate, DebateRound } from "@/lib/orchestrator";

interface DebatePanelProps {
  debates: OrchestratorDebate[];
}

export function DebatePanel({ debates }: DebatePanelProps) {
  return (
    <Card data-testid="debate-panel">
      <CardHeader>
        <CardTitle>Debates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {debates.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="debate-empty">
            No debates in this run.
          </p>
        ) : (
          debates.map((debate) => <DebateItem key={debate.id} debate={debate} />)
        )}
      </CardContent>
    </Card>
  );
}

function DebateItem({ debate }: { debate: OrchestratorDebate }) {
  const [open, setOpen] = useState(false);
  const rounds = groupDebateRounds(debate.rounds);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border border-border"
      data-testid="debate-item"
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors",
          "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        data-testid="debate-trigger"
      >
        <ChevronDown
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          {/* Untrusted question — inert text. */}
          <p className="text-sm font-medium leading-snug break-words">
            {debate.question}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {debate.degraded && (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-600"
                data-testid="debate-degraded"
              >
                <ShieldAlert className="h-3 w-3" />
                Degraded · Opus-only
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {rounds.length} round{rounds.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-3 border-t border-border/60 p-3" data-testid="debate-content">
        <Recommendation debate={debate} />

        <div className="space-y-3" data-testid="debate-rounds">
          {rounds.map((group) => (
            <div key={group.round}>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Round {group.round}
              </h4>
              <div className="space-y-2">
                {group.turns.map((turn, i) => (
                  <DebateTurn key={`${group.round}-${i}`} turn={turn} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DebateTurn({ turn }: { turn: DebateRound }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-2.5" data-testid="debate-turn">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        {/* participant / role / provider are model-config identifiers — inert text. */}
        <span className="text-xs font-medium">{turn.participant}</span>
        <Badge variant="secondary" className="text-[10px]">
          {turn.role}
        </Badge>
        {turn.provider && (
          <span className="text-[10px] text-muted-foreground">{turn.provider}</span>
        )}
      </div>
      {/* Untrusted turn content — inert text, preserves newlines. */}
      <p className="whitespace-pre-line text-sm leading-relaxed text-foreground/85 break-words">
        {turn.content}
      </p>
    </div>
  );
}

function Recommendation({ debate }: { debate: OrchestratorDebate }) {
  const hasArbiter = !!debate.recommendation || debate.confidence != null;
  if (!hasArbiter && !debate.judgeVerdict) return null;

  const confidence = debate.confidence != null ? toPercent(debate.confidence) : null;
  const dissent = debate.dissent ?? [];

  return (
    <div
      className="rounded-md border border-primary/20 bg-primary/5 p-3"
      data-testid="debate-recommendation"
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-primary">
        <Gavel className="h-3.5 w-3.5" />
        Arbiter recommendation
        {confidence != null && (
          <span className="ml-auto tabular-nums text-muted-foreground" data-testid="debate-confidence">
            {confidence}% confidence
          </span>
        )}
      </div>
      {/* Untrusted recommendation / verdict — inert text. */}
      <p className="whitespace-pre-line text-sm leading-relaxed break-words">
        {debate.recommendation ?? debate.judgeVerdict}
      </p>
      {dissent.length > 0 && (
        <div className="mt-2 border-t border-primary/15 pt-2" data-testid="debate-dissent">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Dissent</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {dissent.map((d, i) => (
              <li key={i} className="text-xs leading-relaxed text-foreground/80 break-words">
                {d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
