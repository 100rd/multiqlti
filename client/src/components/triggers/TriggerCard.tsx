import { formatDistanceToNow } from "date-fns";
import { Pencil, Trash2, Zap, Clock, Github, FolderSearch } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useEnableTrigger, useDisableTrigger } from "@/hooks/use-triggers";
import type { PipelineTrigger, TriggerType, ScheduleTriggerConfig, GitHubEventTriggerConfig, FileChangeTriggerConfig } from "@shared/types";

// ─── Type badge config ────────────────────────────────────────────────────────

const TYPE_META: Record<TriggerType, { label: string; className: string; Icon: React.FC<{ className?: string }> }> = {
  webhook: {
    label: "Webhook",
    className: "bg-violet-500/15 text-violet-600 border-violet-500/30",
    Icon: Zap,
  },
  schedule: {
    label: "Schedule",
    className: "bg-blue-500/15 text-blue-600 border-blue-500/30",
    Icon: Clock,
  },
  github_event: {
    label: "GitHub Event",
    className: "bg-gray-500/15 text-gray-700 border-gray-500/30",
    Icon: Github,
  },
  file_change: {
    label: "File Change",
    className: "bg-amber-500/15 text-amber-700 border-amber-500/30",
    Icon: FolderSearch,
  },
};

// ─── Config summary ───────────────────────────────────────────────────────────

function configSummary(trigger: PipelineTrigger): string {
  switch (trigger.type) {
    case "webhook":
      return trigger.webhookUrl
        ? `POST ${trigger.webhookUrl}`
        : "Webhook endpoint auto-assigned";
    case "schedule": {
      const cfg = trigger.config as ScheduleTriggerConfig;
      return cfg.cron;
    }
    case "github_event": {
      const cfg = trigger.config as GitHubEventTriggerConfig;
      return `${cfg.repository} · ${cfg.events.join(", ")}`;
    }
    case "file_change": {
      const cfg = trigger.config as FileChangeTriggerConfig;
      return `${cfg.watchPath} · ${cfg.patterns.join(", ")}`;
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

interface TriggerCardProps {
  trigger: PipelineTrigger;
  pipelineName?: string;
  onEdit: (trigger: PipelineTrigger) => void;
  onDelete: (trigger: PipelineTrigger) => void;
}

export function TriggerCard({ trigger, pipelineName, onEdit, onDelete }: TriggerCardProps) {
  const enable = useEnableTrigger();
  const disable = useDisableTrigger();

  const meta = TYPE_META[trigger.type];
  const Icon = meta.Icon;
  const isPending = enable.isPending || disable.isPending;

  function handleToggle(checked: boolean) {
    if (checked) {
      enable.mutate(trigger.id);
    } else {
      disable.mutate(trigger.id);
    }
  }

  const lastTriggered = trigger.lastTriggeredAt
    ? formatDistanceToNow(new Date(trigger.lastTriggeredAt), { addSuffix: true })
    : "Never";

  return (
    <Card className="border-border p-5">
      <div className="flex items-start justify-between gap-4">
        {/* Left: icon + info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <Icon className="h-4 w-4 text-primary" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className={`text-[10px] h-5 px-1.5 ${meta.className}`}
              >
                {meta.label}
              </Badge>
              {pipelineName && (
                <span className="text-[10px] text-muted-foreground font-medium truncate">
                  {pipelineName}
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground mt-1.5 font-mono truncate">
              {configSummary(trigger)}
            </p>

            <p className="text-[10px] text-muted-foreground mt-1">
              Last triggered: <span className="font-medium">{lastTriggered}</span>
            </p>
          </div>
        </div>

        {/* Right: toggle + actions */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <Switch
              id={`trigger-enabled-${trigger.id}`}
              checked={trigger.enabled}
              onCheckedChange={handleToggle}
              disabled={isPending}
              aria-label={trigger.enabled ? "Disable trigger" : "Enable trigger"}
            />
            <Label
              htmlFor={`trigger-enabled-${trigger.id}`}
              className="text-xs text-muted-foreground cursor-pointer"
            >
              {trigger.enabled ? "On" : "Off"}
            </Label>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onEdit(trigger)}
            aria-label="Edit trigger"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => onDelete(trigger)}
            aria-label="Delete trigger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
