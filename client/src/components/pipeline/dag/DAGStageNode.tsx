import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { cn } from "@/lib/utils";
import type { DAGStage } from "@shared/types";

// Team color → Tailwind border/bg mapping
const TEAM_COLOR_MAP: Record<string, string> = {
  blue:   "border-blue-500 bg-blue-500/10",
  purple: "border-purple-500 bg-purple-500/10",
  green:  "border-green-500 bg-green-500/10",
  amber:  "border-amber-500 bg-amber-500/10",
  orange: "border-orange-500 bg-orange-500/10",
  cyan:   "border-cyan-500 bg-cyan-500/10",
  rose:   "border-rose-500 bg-rose-500/10",
  violet: "border-violet-500 bg-violet-500/10",
};

const TEAM_BADGE_MAP: Record<string, string> = {
  blue:   "bg-blue-500/20 text-blue-300",
  purple: "bg-purple-500/20 text-purple-300",
  green:  "bg-green-500/20 text-green-300",
  amber:  "bg-amber-500/20 text-amber-300",
  orange: "bg-orange-500/20 text-orange-300",
  cyan:   "bg-cyan-500/20 text-cyan-300",
  rose:   "bg-rose-500/20 text-rose-300",
  violet: "bg-violet-500/20 text-violet-300",
};

export const DAGStageNode = memo(({ data }: NodeProps<DAGStage>) => {
  const color = (data as DAGStage & { color?: string }).color ?? "blue";
  const borderCls = TEAM_COLOR_MAP[color] ?? TEAM_COLOR_MAP.blue;
  const badgeCls = TEAM_BADGE_MAP[color] ?? TEAM_BADGE_MAP.blue;
  const label = data.label ?? data.teamId;
  const isDisabled = !data.enabled;

  return (
    <div
      className={cn(
        "relative rounded-lg border-2 p-3 min-w-[160px] max-w-[200px] shadow-md transition-opacity",
        borderCls,
        isDisabled && "opacity-50",
      )}
      aria-label={`Pipeline stage: ${label}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-muted-foreground !border-2 !border-background"
        aria-label="Input connection"
      />

      <div className="flex flex-col gap-1">
        <span className={cn("text-[10px] font-medium rounded px-1.5 py-0.5 self-start truncate max-w-full", badgeCls)}>
          {data.teamId}
        </span>
        <span className="text-xs font-semibold text-foreground leading-tight truncate">
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono truncate">
          {data.modelSlug}
        </span>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-muted-foreground !border-2 !border-background"
        aria-label="Output connection"
      />
    </div>
  );
});

DAGStageNode.displayName = "DAGStageNode";
