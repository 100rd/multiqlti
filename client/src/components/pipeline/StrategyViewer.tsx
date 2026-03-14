import { useState } from "react";
import { ChevronDown, ChevronRight, Layers, MessageSquare, Vote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { StrategyResult, MoaDetails, DebateDetails, VotingDetails } from "@shared/types";

interface StrategyViewerProps {
  strategyResult: StrategyResult;
}

export default function StrategyViewer({ strategyResult }: StrategyViewerProps) {
  const [expanded, setExpanded] = useState(false);

  if (strategyResult.strategy === "single" || !strategyResult.details) {
    return null;
  }

  const strategyLabel = {
    moa: "Mixture of Agents",
    debate: "Debate",
    voting: "Voting",
    single: "Single",
  }[strategyResult.strategy];

  const strategyIcon = {
    moa: <Layers className="h-3 w-3" />,
    debate: <MessageSquare className="h-3 w-3" />,
    voting: <Vote className="h-3 w-3" />,
    single: null,
  }[strategyResult.strategy];

  return (
    <div className="mt-3 border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        {strategyIcon}
        <span className="text-xs font-medium">{strategyLabel} — intermediate steps</span>
        <Badge variant="outline" className="ml-auto text-[9px] h-4 px-1.5">
          {strategyResult.totalTokensUsed} tokens · {Math.round(strategyResult.durationMs / 1000)}s
        </Badge>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-2 space-y-3">
          {strategyResult.strategy === "moa" && (
            <MoaDetailsView details={strategyResult.details as MoaDetails} />
          )}
          {strategyResult.strategy === "debate" && (
            <DebateDetailsView details={strategyResult.details as DebateDetails} />
          )}
          {strategyResult.strategy === "voting" && (
            <VotingDetailsView details={strategyResult.details as VotingDetails} />
          )}
        </div>
      )}
    </div>
  );
}

function MoaDetailsView({ details }: { details: MoaDetails }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
        Proposer Responses
      </p>
      {details.proposerResponses.map((p, idx) => (
        <ProposerCard key={idx} modelSlug={p.modelSlug} role={p.role} content={p.content} index={idx} />
      ))}
      <p className="text-[11px] text-muted-foreground mt-2">
        Aggregated by: <span className="font-mono">{details.aggregatorModelSlug}</span>
      </p>
    </div>
  );
}

function ProposerCard({
  modelSlug,
  role,
  content,
  index,
}: {
  modelSlug: string;
  role?: string;
  content: string;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-muted/30 hover:bg-muted/50 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="text-[11px] font-mono">{modelSlug}</span>
        {role && <Badge variant="secondary" className="text-[9px] h-4 px-1">{role}</Badge>}
        <span className="text-[10px] text-muted-foreground ml-auto">Proposer {index + 1}</span>
      </button>
      {open && (
        <ScrollArea className="max-h-[200px]">
          <pre className="p-2.5 text-[11px] font-mono whitespace-pre-wrap leading-relaxed text-foreground/80">
            {content}
          </pre>
        </ScrollArea>
      )}
    </div>
  );
}

function DebateDetailsView({ details }: { details: DebateDetails }) {
  const rounds = Array.from(new Set(details.rounds.map((r) => r.round))).sort((a, b) => a - b);

  return (
    <div className="space-y-3">
      {rounds.map((round) => {
        const entries = details.rounds.filter((r) => r.round === round);
        return (
          <RoundGroup key={round} round={round} entries={entries} />
        );
      })}
      <div className="border border-primary/30 rounded p-2.5 bg-primary/5">
        <p className="text-[11px] font-medium mb-1 text-primary">
          Judge ({details.judgeModelSlug})
        </p>
        <ScrollArea className="max-h-[200px]">
          <pre className="text-[11px] font-mono whitespace-pre-wrap leading-relaxed">
            {details.verdict}
          </pre>
        </ScrollArea>
      </div>
    </div>
  );
}

const ROLE_COLORS: Record<string, string> = {
  proposer: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  critic: "bg-orange-500/10 text-orange-600 border-orange-500/20",
  devil_advocate: "bg-purple-500/10 text-purple-600 border-purple-500/20",
};

function RoundGroup({
  round,
  entries,
}: {
  round: number;
  entries: DebateDetails["rounds"];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-border rounded overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-muted/30 hover:bg-muted/50 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="text-[11px] font-medium">Round {round}</span>
        <span className="text-[10px] text-muted-foreground ml-1">
          {entries.map((e) => e.role).join(" → ")}
        </span>
      </button>
      {open && (
        <div className="p-2 space-y-2">
          {entries.map((entry, idx) => (
            <div
              key={idx}
              className={cn(
                "rounded border px-2.5 py-2",
                ROLE_COLORS[entry.role] ?? "bg-muted/20 border-border",
              )}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px] font-mono">{entry.participant}</span>
                <Badge variant="outline" className="text-[9px] h-3.5 px-1">
                  {entry.role}
                </Badge>
              </div>
              <ScrollArea className="max-h-[160px]">
                <pre className="text-[11px] font-mono whitespace-pre-wrap leading-relaxed">
                  {entry.content}
                </pre>
              </ScrollArea>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VotingDetailsView({ details }: { details: VotingDetails }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
        Candidates · Agreement: {Math.round(details.agreement * 100)}%
      </p>
      {details.candidates.map((c, idx) => (
        <CandidateCard
          key={idx}
          modelSlug={c.modelSlug}
          content={c.content}
          passed={c.passed}
          isWinner={idx === details.winnerIndex}
          index={idx}
        />
      ))}
    </div>
  );
}

function CandidateCard({
  modelSlug,
  content,
  passed,
  isWinner,
  index,
}: {
  modelSlug: string;
  content: string;
  passed: boolean;
  isWinner: boolean;
  index: number;
}) {
  const [open, setOpen] = useState(isWinner);

  return (
    <div
      className={cn(
        "border rounded overflow-hidden",
        isWinner ? "border-green-500/40 bg-green-500/5" : "border-border",
      )}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/20 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <span className="text-[11px] font-mono">{modelSlug}</span>
        <span className="text-[10px] text-muted-foreground">Candidate {index + 1}</span>
        <div className="ml-auto flex items-center gap-1">
          {isWinner && (
            <Badge className="text-[9px] h-4 px-1 bg-green-600 hover:bg-green-600">Winner</Badge>
          )}
          <Badge
            variant="outline"
            className={cn("text-[9px] h-4 px-1", passed ? "border-green-500/50 text-green-600" : "border-red-500/50 text-red-600")}
          >
            {passed ? "passed" : "failed"}
          </Badge>
        </div>
      </button>
      {open && (
        <ScrollArea className="max-h-[200px]">
          <pre className="p-2.5 text-[11px] font-mono whitespace-pre-wrap leading-relaxed text-foreground/80">
            {content}
          </pre>
        </ScrollArea>
      )}
    </div>
  );
}
