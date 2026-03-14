import { useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { computeCostMultiplier } from "@shared/constants";
import type {
  ExecutionStrategy,
  ExecutionStrategyType,
  MoaStrategy,
  DebateStrategy,
  VotingStrategy,
  ProposerConfig,
  DebateParticipant,
  CandidateConfig,
} from "@shared/types";

interface ModelOption {
  label: string;
  value: string;
  provider: string;
}

interface StrategyConfigProps {
  strategy: ExecutionStrategy | undefined;
  models: ModelOption[];
  defaultModelSlug: string;
  enabled: boolean;
  onChange: (strategy: ExecutionStrategy) => void;
}

const STRATEGY_OPTIONS: Array<{ value: ExecutionStrategyType; label: string; description: string }> = [
  { value: "single", label: "Single", description: "One model, one response" },
  { value: "moa", label: "Mixture of Agents", description: "Parallel proposers + aggregator" },
  { value: "debate", label: "Debate", description: "Proposer vs critic, judge decides" },
  { value: "voting", label: "Voting", description: "Multiple candidates, consensus winner" },
];

export default function StrategyConfig({
  strategy,
  models,
  defaultModelSlug,
  enabled,
  onChange,
}: StrategyConfigProps) {
  const [expanded, setExpanded] = useState(false);
  const currentType: ExecutionStrategyType = strategy?.type ?? "single";
  const multiplier = strategy ? computeCostMultiplier(strategy as Parameters<typeof computeCostMultiplier>[0]) : 1;

  const handleTypeChange = (type: ExecutionStrategyType) => {
    switch (type) {
      case "single":
        onChange({ type: "single" });
        break;
      case "moa":
        onChange({
          type: "moa",
          proposers: [
            { modelSlug: defaultModelSlug, role: "primary", temperature: 0.7 },
            { modelSlug: models[1]?.value ?? defaultModelSlug, role: "alternative", temperature: 0.6 },
          ],
          aggregator: { modelSlug: defaultModelSlug },
        });
        break;
      case "debate":
        onChange({
          type: "debate",
          participants: [
            { modelSlug: defaultModelSlug, role: "proposer" },
            { modelSlug: models[1]?.value ?? defaultModelSlug, role: "critic" },
          ],
          judge: { modelSlug: defaultModelSlug },
          rounds: 3,
        });
        break;
      case "voting":
        onChange({
          type: "voting",
          candidates: [
            { modelSlug: defaultModelSlug, temperature: 0.5 },
            { modelSlug: models[1]?.value ?? defaultModelSlug, temperature: 0.6 },
            { modelSlug: models[2]?.value ?? defaultModelSlug, temperature: 0.7 },
          ],
          threshold: 0.6,
          validationMode: "text_similarity",
        });
        break;
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        disabled={!enabled}
      >
        <span>Strategy</span>
        {currentType !== "single" && (
          <Badge variant="secondary" className="text-[9px] h-4 px-1 ml-1">
            {strategyBadge(strategy!)}
          </Badge>
        )}
        {multiplier > 1 && (
          <span className="text-[10px] text-amber-500 ml-1">{multiplier}x cost</span>
        )}
        {expanded
          ? <ChevronUp className="h-3 w-3 ml-1" />
          : <ChevronDown className="h-3 w-3 ml-1" />}
      </button>

      {expanded && (
        <div className="mt-3 p-3 rounded border border-border bg-muted/30 space-y-3">
          {/* Strategy type selector */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Execution Strategy
            </label>
            <Select value={currentType} onValueChange={(v) => handleTypeChange(v as ExecutionStrategyType)} disabled={!enabled}>
              <SelectTrigger className="h-8 text-xs bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRATEGY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <div>
                      <span>{opt.label}</span>
                      <span className="text-muted-foreground ml-2 text-[10px]">{opt.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* MoA config */}
          {strategy?.type === "moa" && (
            <MoaConfig strategy={strategy} models={models} enabled={enabled} onChange={onChange} />
          )}

          {/* Debate config */}
          {strategy?.type === "debate" && (
            <DebateConfig strategy={strategy} models={models} enabled={enabled} onChange={onChange} />
          )}

          {/* Voting config */}
          {strategy?.type === "voting" && (
            <VotingConfig strategy={strategy} models={models} enabled={enabled} onChange={onChange} />
          )}

          {/* Cost estimate */}
          {currentType !== "single" && (
            <p className="text-[10px] text-amber-500/80">
              Estimated cost: ~{multiplier}x a single call per stage execution
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MoA Config ──────────────────────────────────────────────────────────────

function MoaConfig({
  strategy,
  models,
  enabled,
  onChange,
}: {
  strategy: MoaStrategy;
  models: ModelOption[];
  enabled: boolean;
  onChange: (s: ExecutionStrategy) => void;
}) {
  const addProposer = () => {
    if (strategy.proposers.length >= 5) return;
    onChange({
      ...strategy,
      proposers: [
        ...strategy.proposers,
        { modelSlug: models[0]?.value ?? "llama3-70b", temperature: 0.7 },
      ],
    });
  };

  const removeProposer = (idx: number) => {
    if (strategy.proposers.length <= 1) return;
    onChange({
      ...strategy,
      proposers: strategy.proposers.filter((_, i) => i !== idx),
    });
  };

  const updateProposer = (idx: number, patch: Partial<ProposerConfig>) => {
    onChange({
      ...strategy,
      proposers: strategy.proposers.map((p, i) => i === idx ? { ...p, ...patch } : p),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Proposers ({strategy.proposers.length}/5)</label>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2"
          onClick={addProposer}
          disabled={!enabled || strategy.proposers.length >= 5}
        >
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>

      {strategy.proposers.map((p, idx) => (
        <div key={idx} className="flex gap-1.5 items-center">
          <Select
            value={p.modelSlug}
            onValueChange={(v) => updateProposer(idx, { modelSlug: v })}
            disabled={!enabled}
          >
            <SelectTrigger className="h-7 text-[11px] flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[10px] text-muted-foreground w-6 text-center shrink-0">
            {(p.temperature ?? 0.7).toFixed(1)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => removeProposer(idx)}
            disabled={!enabled || strategy.proposers.length <= 1}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Aggregator</label>
        <Select
          value={strategy.aggregator.modelSlug}
          onValueChange={(v) => onChange({ ...strategy, aggregator: { ...strategy.aggregator, modelSlug: v } })}
          disabled={!enabled}
        >
          <SelectTrigger className="h-7 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ─── Debate Config ────────────────────────────────────────────────────────────

const DEBATE_ROLES: DebateParticipant["role"][] = ["proposer", "critic", "devil_advocate"];
const ROLE_LABELS: Record<DebateParticipant["role"], string> = {
  proposer: "Proposer",
  critic: "Critic",
  devil_advocate: "Devil's Advocate",
};

function DebateConfig({
  strategy,
  models,
  enabled,
  onChange,
}: {
  strategy: DebateStrategy;
  models: ModelOption[];
  enabled: boolean;
  onChange: (s: ExecutionStrategy) => void;
}) {
  const addParticipant = () => {
    onChange({
      ...strategy,
      participants: [
        ...strategy.participants,
        { modelSlug: models[0]?.value ?? "llama3-70b", role: "critic" },
      ],
    });
  };

  const removeParticipant = (idx: number) => {
    if (strategy.participants.length <= 2) return;
    onChange({ ...strategy, participants: strategy.participants.filter((_, i) => i !== idx) });
  };

  const updateParticipant = (idx: number, patch: Partial<DebateParticipant>) => {
    onChange({
      ...strategy,
      participants: strategy.participants.map((p, i) => i === idx ? { ...p, ...patch } : p),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Participants</label>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2"
          onClick={addParticipant}
          disabled={!enabled}
        >
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>

      {strategy.participants.map((p, idx) => (
        <div key={idx} className="flex gap-1.5 items-center">
          <Select
            value={p.modelSlug}
            onValueChange={(v) => updateParticipant(idx, { modelSlug: v })}
            disabled={!enabled}
          >
            <SelectTrigger className="h-7 text-[11px] flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={p.role}
            onValueChange={(v) => updateParticipant(idx, { role: v as DebateParticipant["role"] })}
            disabled={!enabled}
          >
            <SelectTrigger className="h-7 text-[11px] w-28 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEBATE_ROLES.map((r) => (
                <SelectItem key={r} value={r} className="text-xs">{ROLE_LABELS[r]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => removeParticipant(idx)}
            disabled={!enabled || strategy.participants.length <= 2}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Judge</label>
        <Select
          value={strategy.judge.modelSlug}
          onValueChange={(v) => onChange({ ...strategy, judge: { ...strategy.judge, modelSlug: v } })}
          disabled={!enabled}
        >
          <SelectTrigger className="h-7 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-muted-foreground">Rounds</label>
          <span className="text-xs font-mono">{strategy.rounds}</span>
        </div>
        <Slider
          min={1}
          max={5}
          step={1}
          value={[strategy.rounds]}
          onValueChange={([v]) => onChange({ ...strategy, rounds: v })}
          disabled={!enabled}
          className="h-4"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
          <span>1</span>
          <span>5</span>
        </div>
      </div>
    </div>
  );
}

// ─── Voting Config ────────────────────────────────────────────────────────────

function VotingConfig({
  strategy,
  models,
  enabled,
  onChange,
}: {
  strategy: VotingStrategy;
  models: ModelOption[];
  enabled: boolean;
  onChange: (s: ExecutionStrategy) => void;
}) {
  const addCandidate = () => {
    if (strategy.candidates.length >= 7) return;
    onChange({
      ...strategy,
      candidates: [...strategy.candidates, { modelSlug: models[0]?.value ?? "llama3-70b", temperature: 0.7 }],
    });
  };

  const removeCandidate = (idx: number) => {
    if (strategy.candidates.length <= 2) return;
    onChange({ ...strategy, candidates: strategy.candidates.filter((_, i) => i !== idx) });
  };

  const updateCandidate = (idx: number, patch: Partial<CandidateConfig>) => {
    onChange({
      ...strategy,
      candidates: strategy.candidates.map((c, i) => i === idx ? { ...c, ...patch } : c),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          Candidates ({strategy.candidates.length}/7)
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2"
          onClick={addCandidate}
          disabled={!enabled || strategy.candidates.length >= 7}
        >
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>

      {strategy.candidates.map((c, idx) => (
        <div key={idx} className="flex gap-1.5 items-center">
          <Select
            value={c.modelSlug}
            onValueChange={(v) => updateCandidate(idx, { modelSlug: v })}
            disabled={!enabled}
          >
            <SelectTrigger className="h-7 text-[11px] flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[10px] text-muted-foreground shrink-0 w-8">
            t={((c.temperature ?? 0.7)).toFixed(1)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => removeCandidate(idx)}
            disabled={!enabled || strategy.candidates.length <= 2}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      ))}

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-muted-foreground">Consensus Threshold</label>
          <span className="text-xs font-mono">{strategy.threshold.toFixed(2)}</span>
        </div>
        <Slider
          min={0.5}
          max={1.0}
          step={0.05}
          value={[strategy.threshold]}
          onValueChange={([v]) => onChange({ ...strategy, threshold: v })}
          disabled={!enabled}
          className="h-4"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
          <span>Lenient (0.5)</span>
          <span>Strict (1.0)</span>
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Validation Mode</label>
        <div className="flex gap-2">
          {(["text_similarity", "test_execution"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={!enabled}
              onClick={() => onChange({ ...strategy, validationMode: mode })}
              className={cn(
                "text-[11px] px-2 py-1 rounded border transition-colors",
                strategy.validationMode === mode
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {mode === "text_similarity" ? "Text Similarity" : "Test Execution"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Badge helper ─────────────────────────────────────────────────────────────

function strategyBadge(strategy: ExecutionStrategy): string {
  switch (strategy.type) {
    case "moa": return `MoA×${(strategy as MoaStrategy).proposers.length}`;
    case "debate": return `Debate ${(strategy as DebateStrategy).rounds}r`;
    case "voting": return `Vote×${(strategy as VotingStrategy).candidates.length}`;
    default: return "Single";
  }
}
