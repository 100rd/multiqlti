import { cn } from "@/lib/utils";
import { Check, X, Loader2, Minus, Pause } from "lucide-react";
import { SDLC_TEAMS, TEAM_ORDER } from "@shared/constants";
import type { StageStatus } from "@shared/types";

interface StageInfo {
  teamId: string;
  modelSlug: string;
  status: StageStatus;
  output?: Record<string, unknown>;
  tokensUsed?: number;
}

interface StageProgressProps {
  stages: Map<number, StageInfo>;
  currentStageIndex: number;
  pipelineStages?: Array<{ teamId: string; modelSlug: string; enabled: boolean }>;
}

const statusConfig: Record<
  StageStatus,
  { icon: React.ReactNode; color: string; bg: string }
> = {
  pending: {
    icon: <div className="w-2 h-2 rounded-full bg-muted-foreground" />,
    color: "text-muted-foreground",
    bg: "bg-muted",
  },
  running: {
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
    color: "text-blue-500",
    bg: "bg-blue-500/10",
  },
  paused: {
    icon: <Pause className="h-3.5 w-3.5" />,
    color: "text-amber-500",
    bg: "bg-amber-500/10",
  },
  completed: {
    icon: <Check className="h-3.5 w-3.5" />,
    color: "text-emerald-500",
    bg: "bg-emerald-500/10",
  },
  failed: {
    icon: <X className="h-3.5 w-3.5" />,
    color: "text-red-500",
    bg: "bg-red-500/10",
  },
  skipped: {
    icon: <Minus className="h-3.5 w-3.5" />,
    color: "text-muted-foreground",
    bg: "bg-muted",
  },
};

export default function StageProgress({
  stages,
  currentStageIndex,
  pipelineStages,
}: StageProgressProps) {
  const stageList = pipelineStages ?? TEAM_ORDER.map((teamId) => ({
    teamId,
    modelSlug: SDLC_TEAMS[teamId].defaultModelSlug,
    enabled: true,
  }));

  return (
    <div className="space-y-1">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Pipeline Stages
      </h3>
      {stageList.map((stage, idx) => {
        const stageInfo = stages.get(idx);
        const status: StageStatus = stageInfo?.status ?? (stage.enabled ? "pending" : "skipped");
        const config = statusConfig[status];
        const team = SDLC_TEAMS[stage.teamId as keyof typeof SDLC_TEAMS];
        const isActive = idx === currentStageIndex && status === "running";
        // Prefer the live model slug from stage execution data; fall back to the configured slug
        const modelSlug = stageInfo?.modelSlug ?? stage.modelSlug;

        return (
          <div
            key={idx}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md transition-colors",
              isActive && "bg-accent/50 border border-border",
            )}
          >
            <div
              className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
                config.bg,
                config.color,
              )}
            >
              {config.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className={cn("text-xs font-medium truncate", config.color)}>
                {team?.name ?? stage.teamId}
              </p>
              {modelSlug && (
                <p className="text-[10px] text-muted-foreground font-mono truncate">
                  {modelSlug}
                </p>
              )}
              {stageInfo?.tokensUsed ? (
                <p className="text-[10px] text-muted-foreground">
                  {stageInfo.tokensUsed.toLocaleString()} tokens
                </p>
              ) : null}
            </div>
            <span
              className={cn(
                "text-[10px] font-mono uppercase",
                config.color,
              )}
            >
              {status}
            </span>
          </div>
        );
      })}
    </div>
  );
}
