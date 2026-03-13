import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SDLC_TEAMS } from "@shared/constants";

interface ModelOption {
  label: string;
  value: string;
  provider: string;
}

interface AgentNodeProps {
  id: string;
  role: string;
  model: string;
  description: string;
  enabled: boolean;
  color: string;
  models: ModelOption[];
  onModelChange: (id: string, model: string) => void;
  onToggle: () => void;
  isLast: boolean;
}

const COLOR_MAP: Record<string, string> = {
  blue: "border-l-blue-500",
  purple: "border-l-purple-500",
  green: "border-l-green-500",
  amber: "border-l-amber-500",
  orange: "border-l-orange-500",
  cyan: "border-l-cyan-500",
  rose: "border-l-rose-500",
};

const DOT_COLOR_MAP: Record<string, string> = {
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  green: "bg-green-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  cyan: "bg-cyan-500",
  rose: "bg-rose-500",
};

export default function AgentNode({
  id,
  role,
  model,
  description,
  enabled,
  color,
  models,
  onModelChange,
  onToggle,
  isLast,
}: AgentNodeProps) {
  const team = SDLC_TEAMS[role as keyof typeof SDLC_TEAMS];
  const teamName = team?.name ?? role;

  return (
    <div className="relative">
      <Card className={cn(
        "border-border shadow-sm bg-card transition-all border-l-4",
        COLOR_MAP[color] ?? "border-l-muted",
        !enabled && "opacity-50",
      )}>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1">
              <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", DOT_COLOR_MAP[color] ?? "bg-muted")} />
              <div>
                <CardTitle className="text-sm font-semibold">{teamName}</CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
              </div>
            </div>
            <Switch checked={enabled} onCheckedChange={onToggle} />
          </div>
        </CardHeader>

        <CardContent className="pt-0 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Model</label>
            <Select value={model} onValueChange={(val) => onModelChange(id, val)} disabled={!enabled}>
              <SelectTrigger className="h-8 text-xs bg-background border-border">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {models.map(m => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                    <span className="text-muted-foreground ml-1">({m.provider})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {team && (
            <div className="p-2 rounded bg-muted/50 border border-border">
              <div className="text-[10px] font-mono text-muted-foreground/70">
                Tools: {team.tools.join(", ")}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Connection line to next stage */}
      {!isLast && (
        <div className="absolute left-1/2 -bottom-6 w-[2px] h-6 bg-border -translate-x-1/2" />
      )}
    </div>
  );
}
