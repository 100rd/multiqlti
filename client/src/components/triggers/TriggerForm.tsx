import { useState, useEffect } from "react";
import { RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateTrigger, useUpdateTrigger } from "@/hooks/use-triggers";
import { WebhookDetails } from "./WebhookDetails";
import type {
  PipelineTrigger,
  TriggerType,
  InsertTrigger,
  ScheduleTriggerConfig,
  GitHubEventTriggerConfig,
  FileChangeTriggerConfig,
} from "@shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Pipeline {
  id: string;
  name: string;
}

interface TriggerFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipelines: Pipeline[];
  /** When provided, the form is in edit mode */
  trigger?: PipelineTrigger;
  /** Pre-select a pipeline when creating */
  defaultPipelineId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseCronHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "";
  const [min, hour, dom, month, dow] = parts;
  if (dom === "*" && month === "*" && dow === "*") {
    if (min === "0" && hour !== "*")
      return `Every day at ${hour.padStart(2, "0")}:00 UTC`;
    if (min !== "*" && hour !== "*")
      return `Every day at ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
  }
  if (dow !== "*" && dom === "*" && month === "*")
    return `Weekly (day ${dow}) at ${hour}:${min} UTC`;
  return "";
}

const GITHUB_EVENT_OPTIONS = [
  "push",
  "pull_request",
  "issues",
  "release",
  "workflow_run",
  "create",
  "delete",
] as const;

// ─── Sub-forms ────────────────────────────────────────────────────────────────

function WebhookConfigFields({
  secret,
  onSecretChange,
}: {
  secret: string;
  onSecretChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="webhook-secret-input" className="text-xs">
        HMAC Secret <span className="text-muted-foreground">(optional)</span>
      </Label>
      <div className="flex gap-2">
        <Input
          id="webhook-secret-input"
          type="password"
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
          placeholder="Leave blank to skip signature verification"
          className="font-mono text-xs h-8"
          autoComplete="new-password"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-3 shrink-0"
          onClick={() => onSecretChange(generateSecret())}
          aria-label="Generate random secret"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Generate
        </Button>
      </div>
    </div>
  );
}

function ScheduleConfigFields({
  cron,
  onChange,
}: {
  cron: string;
  onChange: (v: string) => void;
}) {
  const human = parseCronHuman(cron);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="cron-input" className="text-xs">
        Cron Expression <span className="text-destructive">*</span>
      </Label>
      <Input
        id="cron-input"
        value={cron}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0 9 * * 1-5"
        className="font-mono text-xs h-8"
        required
        aria-describedby={human ? "cron-human" : undefined}
      />
      {human && (
        <p id="cron-human" className="text-[10px] text-muted-foreground">
          {human}
        </p>
      )}
    </div>
  );
}

function GitHubConfigFields({
  repository,
  events,
  onChange,
}: {
  repository: string;
  events: string[];
  onChange: (patch: Partial<GitHubEventTriggerConfig>) => void;
}) {
  function toggleEvent(ev: string) {
    const next = events.includes(ev)
      ? events.filter((e) => e !== ev)
      : [...events, ev];
    onChange({ events: next });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="gh-repo" className="text-xs">
          Repository <span className="text-destructive">*</span>
        </Label>
        <Input
          id="gh-repo"
          value={repository}
          onChange={(e) => onChange({ repository: e.target.value })}
          placeholder="owner/repo"
          className="text-xs h-8"
          required
        />
      </div>

      <fieldset>
        <legend className="text-xs font-medium mb-2">
          Events <span className="text-destructive">*</span>
        </legend>
        <div className="grid grid-cols-2 gap-1.5">
          {GITHUB_EVENT_OPTIONS.map((ev) => (
            <div key={ev} className="flex items-center gap-2">
              <Checkbox
                id={`gh-event-${ev}`}
                checked={events.includes(ev)}
                onCheckedChange={() => toggleEvent(ev)}
              />
              <Label
                htmlFor={`gh-event-${ev}`}
                className="text-xs font-mono cursor-pointer"
              >
                {ev}
              </Label>
            </div>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function FileChangeConfigFields({
  watchPath,
  patterns,
  onChange,
}: {
  watchPath: string;
  patterns: string[];
  onChange: (patch: Partial<FileChangeTriggerConfig>) => void;
}) {
  const patternsStr = patterns.join(", ");

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="watch-path" className="text-xs">
          Watch Path <span className="text-destructive">*</span>
        </Label>
        <Input
          id="watch-path"
          value={watchPath}
          onChange={(e) => onChange({ watchPath: e.target.value })}
          placeholder="/workspace/src"
          className="font-mono text-xs h-8"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="file-patterns" className="text-xs">
          Patterns <span className="text-muted-foreground">(comma-separated globs)</span>
        </Label>
        <Input
          id="file-patterns"
          value={patternsStr}
          onChange={(e) =>
            onChange({
              patterns: e.target.value
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean),
            })
          }
          placeholder="**/*.ts, !node_modules/**"
          className="font-mono text-xs h-8"
        />
      </div>
    </div>
  );
}

// ─── Main form ────────────────────────────────────────────────────────────────

export function TriggerForm({
  open,
  onOpenChange,
  pipelines,
  trigger,
  defaultPipelineId,
}: TriggerFormProps) {
  const isEdit = !!trigger;
  const createTrigger = useCreateTrigger();
  const updateTrigger = useUpdateTrigger();

  // ── State ──────────────────────────────────────────────────────────────────
  const [pipelineId, setPipelineId] = useState(
    trigger?.pipelineId ?? defaultPipelineId ?? pipelines[0]?.id ?? "",
  );
  const [type, setType] = useState<TriggerType>(trigger?.type ?? "webhook");
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);
  const [webhookSecret, setWebhookSecret] = useState("");
  const [cron, setCron] = useState(
    type === "schedule"
      ? (trigger?.config as ScheduleTriggerConfig)?.cron ?? ""
      : "",
  );
  const [ghRepo, setGhRepo] = useState(
    type === "github_event"
      ? (trigger?.config as GitHubEventTriggerConfig)?.repository ?? ""
      : "",
  );
  const [ghEvents, setGhEvents] = useState<string[]>(
    type === "github_event"
      ? (trigger?.config as GitHubEventTriggerConfig)?.events ?? []
      : [],
  );
  const [watchPath, setWatchPath] = useState(
    type === "file_change"
      ? (trigger?.config as FileChangeTriggerConfig)?.watchPath ?? ""
      : "",
  );
  const [filePatterns, setFilePatterns] = useState<string[]>(
    type === "file_change"
      ? (trigger?.config as FileChangeTriggerConfig)?.patterns ?? []
      : [],
  );

  // Created webhook result (shown after creation)
  const [createdWebhook, setCreatedWebhook] = useState<{
    url: string;
    secret: string;
  } | null>(null);

  // Reset when trigger prop changes
  useEffect(() => {
    if (!open) {
      setCreatedWebhook(null);
      return;
    }
    setPipelineId(trigger?.pipelineId ?? defaultPipelineId ?? pipelines[0]?.id ?? "");
    setType(trigger?.type ?? "webhook");
    setEnabled(trigger?.enabled ?? true);
    setWebhookSecret("");
    setCron(
      trigger?.type === "schedule"
        ? (trigger.config as ScheduleTriggerConfig).cron
        : "",
    );
    setGhRepo(
      trigger?.type === "github_event"
        ? (trigger.config as GitHubEventTriggerConfig).repository
        : "",
    );
    setGhEvents(
      trigger?.type === "github_event"
        ? (trigger.config as GitHubEventTriggerConfig).events
        : [],
    );
    setWatchPath(
      trigger?.type === "file_change"
        ? (trigger.config as FileChangeTriggerConfig).watchPath
        : "",
    );
    setFilePatterns(
      trigger?.type === "file_change"
        ? (trigger.config as FileChangeTriggerConfig).patterns
        : [],
    );
  }, [open, trigger, defaultPipelineId, pipelines]);

  // ── Build config ────────────────────────────────────────────────────────────
  function buildConfig():
    | Record<string, never>
    | ScheduleTriggerConfig
    | GitHubEventTriggerConfig
    | FileChangeTriggerConfig {
    switch (type) {
      case "webhook":
        return {};
      case "schedule":
        return { cron };
      case "github_event":
        return { repository: ghRepo, events: ghEvents };
      case "file_change":
        return { watchPath, patterns: filePatterns };
    }
  }

  // ── Validation ──────────────────────────────────────────────────────────────
  function isValid(): boolean {
    if (!pipelineId) return false;
    if (type === "schedule") return cron.trim().length > 0;
    if (type === "github_event")
      return ghRepo.trim().length > 0 && ghEvents.length > 0;
    if (type === "file_change") return watchPath.trim().length > 0;
    return true;
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid()) return;

    if (isEdit && trigger) {
      updateTrigger.mutate(
        { id: trigger.id, type, config: buildConfig(), enabled },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      const payload: InsertTrigger & { _plainSecret?: string } = {
        pipelineId,
        type,
        config: buildConfig(),
        enabled,
        _plainSecret: webhookSecret || undefined,
      };
      createTrigger.mutate(payload, {
        onSuccess: (created) => {
          if (type === "webhook" && created.webhookUrl && webhookSecret) {
            setCreatedWebhook({ url: created.webhookUrl, secret: webhookSecret });
          } else {
            onOpenChange(false);
          }
        },
      });
    }
  }

  const isPending = createTrigger.isPending || updateTrigger.isPending;
  const error = createTrigger.error ?? updateTrigger.error;

  // ── After-creation webhook reveal ───────────────────────────────────────────
  if (createdWebhook) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Webhook Created</DialogTitle>
          </DialogHeader>
          <WebhookDetails
            webhookUrl={createdWebhook.url}
            secret={createdWebhook.secret}
          />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Trigger" : "Add Trigger"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Pipeline selector */}
          <div className="space-y-1.5">
            <Label htmlFor="pipeline-select" className="text-xs">
              Pipeline <span className="text-destructive">*</span>
            </Label>
            <Select
              value={pipelineId}
              onValueChange={setPipelineId}
              disabled={isEdit}
            >
              <SelectTrigger id="pipeline-select" className="h-8 text-xs">
                <SelectValue placeholder="Select a pipeline" />
              </SelectTrigger>
              <SelectContent>
                {pipelines.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Type selector */}
          <div className="space-y-1.5">
            <Label htmlFor="type-select" className="text-xs">
              Trigger Type <span className="text-destructive">*</span>
            </Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as TriggerType)}
              disabled={isEdit}
            >
              <SelectTrigger id="type-select" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="webhook" className="text-xs">Webhook</SelectItem>
                <SelectItem value="schedule" className="text-xs">Schedule (Cron)</SelectItem>
                <SelectItem value="github_event" className="text-xs">GitHub Event</SelectItem>
                <SelectItem value="file_change" className="text-xs">File Change</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Dynamic config fields */}
          {type === "webhook" && (
            <WebhookConfigFields
              secret={webhookSecret}
              onSecretChange={setWebhookSecret}
            />
          )}
          {type === "schedule" && (
            <ScheduleConfigFields cron={cron} onChange={setCron} />
          )}
          {type === "github_event" && (
            <GitHubConfigFields
              repository={ghRepo}
              events={ghEvents}
              onChange={(patch) => {
                if (patch.repository !== undefined) setGhRepo(patch.repository);
                if (patch.events !== undefined) setGhEvents(patch.events);
              }}
            />
          )}
          {type === "file_change" && (
            <FileChangeConfigFields
              watchPath={watchPath}
              patterns={filePatterns}
              onChange={(patch) => {
                if (patch.watchPath !== undefined) setWatchPath(patch.watchPath);
                if (patch.patterns !== undefined) setFilePatterns(patch.patterns);
              }}
            />
          )}

          {/* Enabled checkbox */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="enabled-checkbox"
              checked={enabled}
              onCheckedChange={(v) => setEnabled(v === true)}
            />
            <Label htmlFor="enabled-checkbox" className="text-xs cursor-pointer">
              Enable trigger immediately
            </Label>
          </div>

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error.message}
            </p>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isPending || !isValid()}
            >
              {isPending
                ? "Saving…"
                : isEdit
                  ? "Save Changes"
                  : "Create Trigger"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
