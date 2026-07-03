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
import {
  LOOP_FIRING_TYPES,
  GITHUB_EVENT_MAPPINGS,
  isTriggerFormValid,
  buildLoopTemplate,
  type LoopTemplateState,
} from "./trigger-form-logic";
import {
  CONSILIUM_REVIEW_PRESETS,
  type PipelineTrigger,
  type TriggerType,
  type InsertTrigger,
  type ConsiliumReviewPreset,
  type ConsiliumReviewTriggerAction,
  type ScheduleTriggerConfig,
  type GitHubEventTriggerConfig,
  type FileChangeTriggerConfig,
} from "@shared/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A repo the trigger's loop can target — one of the active project's workspaces. */
export interface TriggerWorkspaceOption {
  path: string;
  name: string;
}

interface TriggerFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active project's allowlisted workspaces — the loop target picklist. */
  workspaces: TriggerWorkspaceOption[];
  /** When provided, the form is in edit mode */
  trigger?: PipelineTrigger;
}

const PRESET_LABELS: Record<ConsiliumReviewPreset, string> = {
  "sdlc-cross-review": "SDLC cross-review",
  "diff-pr-review": "Diff / PR review",
  "full-viability": "Full viability",
};

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

// ─── Loop-template sub-form (schedule + file_change) ────────────────────────────

function LoopTemplateFields({
  state,
  workspaces,
  repoRequired,
  hidePreset,
  onChange,
}: {
  state: LoopTemplateState;
  workspaces: TriggerWorkspaceOption[];
  repoRequired: boolean;
  /** github triggers derive the preset per-event, so the picker is hidden there. */
  hidePreset?: boolean;
  onChange: (patch: Partial<LoopTemplateState>) => void;
}) {
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium">Consilium loop target</legend>

      {!hidePreset && (
        <div className="space-y-1.5">
          <Label htmlFor="loop-preset" className="text-xs">
            Preset <span className="text-destructive">*</span>
          </Label>
          <Select
            value={state.preset}
            onValueChange={(v) => onChange({ preset: v as ConsiliumReviewPreset })}
          >
            <SelectTrigger id="loop-preset" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONSILIUM_REVIEW_PRESETS.map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {PRESET_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="loop-repo" className="text-xs">
          Repository{" "}
          {repoRequired ? (
            <span className="text-destructive">*</span>
          ) : (
            <span className="text-muted-foreground">(defaults to the watched repo)</span>
          )}
        </Label>
        <Select value={state.repoPath} onValueChange={(v) => onChange({ repoPath: v })}>
          <SelectTrigger id="loop-repo" className="h-8 text-xs">
            <SelectValue placeholder="Select a workspace" />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.path} value={w.path} className="text-xs">
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">
          Re-validated against the allowed repo paths when the trigger fires.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="loop-instruction" className="text-xs">
          Instruction <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="loop-instruction"
          value={state.engineerInstruction}
          onChange={(e) => onChange({ engineerInstruction: e.target.value })}
          placeholder="Review the change: ${event}"
          className="text-xs h-8"
        />
        <p className="text-[10px] text-muted-foreground">
          Use <code className="font-mono">{"${event}"}</code> to insert a description of the firing event.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="loop-max-rounds" className="text-xs">
          Max rounds <span className="text-muted-foreground">(1–6)</span>
        </Label>
        <Input
          id="loop-max-rounds"
          type="number"
          min={1}
          max={6}
          value={state.maxRounds}
          onChange={(e) => onChange({ maxRounds: e.target.value })}
          className="text-xs h-8 w-24"
        />
        <p className="text-[10px] text-muted-foreground">
          Automated fires run review-only (1 round) in this release.
        </p>
      </div>
    </fieldset>
  );
}

// ─── Other sub-forms ────────────────────────────────────────────────────────────

function WebhookConfigFields({
  secret,
  onSecretChange,
}: {
  secret: string;
  onSecretChange: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        Webhook and GitHub-event receivers do not yet create loops — the HTTP receiver is
        coming in a follow-up. The trigger persists so it is ready when the receiver ships.
      </p>
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
  secret,
  onSecretChange,
  onChange,
}: {
  repository: string;
  events: string[];
  secret: string;
  onSecretChange: (v: string) => void;
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
      <p className="text-[11px] text-muted-foreground">
        A matching GitHub event fires a consilium review. After you create the trigger you get
        a webhook URL and secret to paste into the repository&apos;s{" "}
        <span className="font-mono">Settings → Webhooks</span> (content type{" "}
        <span className="font-mono">application/json</span>).
      </p>

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

      <div className="rounded-md border border-border p-2.5">
        <p className="text-[11px] font-medium mb-1">What fires a review</p>
        <ul className="space-y-0.5">
          {GITHUB_EVENT_MAPPINGS.map((m) => (
            <li key={m.event} className="text-[10px] text-muted-foreground">
              <span className="font-mono">{m.event}</span> → {m.effect}
            </li>
          ))}
        </ul>
        <p className="text-[10px] text-muted-foreground mt-1">
          Other events are received and acknowledged but launch nothing.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="gh-secret-input" className="text-xs">
          HMAC Secret <span className="text-muted-foreground">(recommended)</span>
        </Label>
        <div className="flex gap-2">
          <Input
            id="gh-secret-input"
            type="password"
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            placeholder="Paste into GitHub → Webhooks → Secret"
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
        <p className="text-[10px] text-muted-foreground">
          Signs the{" "}
          <span className="font-mono font-semibold">X-Hub-Signature-256</span> header; the
          receiver rejects any request whose signature does not match.
        </p>
      </div>
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
  workspaces,
  trigger,
}: TriggerFormProps) {
  const isEdit = !!trigger;
  const createTrigger = useCreateTrigger();
  const updateTrigger = useUpdateTrigger();

  // ── State ──────────────────────────────────────────────────────────────────
  const [type, setType] = useState<TriggerType>(trigger?.type ?? "schedule");
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);
  const [webhookSecret, setWebhookSecret] = useState("");
  const [cron, setCron] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghEvents, setGhEvents] = useState<string[]>([]);
  const [watchPath, setWatchPath] = useState("");
  const [filePatterns, setFilePatterns] = useState<string[]>([]);
  const [template, setTemplate] = useState<LoopTemplateState>({
    preset: "sdlc-cross-review",
    repoPath: workspaces[0]?.path ?? "",
    engineerInstruction: "",
    maxRounds: "1",
  });

  // Created webhook result (shown after creation)
  const [createdWebhook, setCreatedWebhook] = useState<{
    url: string;
    secret: string;
  } | null>(null);

  // Reset when the dialog opens / the edited trigger changes.
  useEffect(() => {
    if (!open) {
      setCreatedWebhook(null);
      return;
    }
    setType(trigger?.type ?? "schedule");
    setEnabled(trigger?.enabled ?? true);
    setWebhookSecret("");
    setCron(
      trigger?.type === "schedule" ? (trigger.config as ScheduleTriggerConfig).cron : "",
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
        ? (trigger.config as FileChangeTriggerConfig).patterns ?? []
        : [],
    );
    const action =
      trigger && (trigger.config as { action?: ConsiliumReviewTriggerAction }).action;
    setTemplate({
      preset: action?.preset ?? "sdlc-cross-review",
      repoPath: action?.repoPath ?? workspaces[0]?.path ?? "",
      engineerInstruction: action?.engineerInstruction ?? "",
      maxRounds: action?.maxRounds ? String(action.maxRounds) : "1",
    });
  }, [open, trigger, workspaces]);

  // github triggers also carry a loop template (the review's target repo), but the
  // preset is derived per-event, so its picker is hidden and a repo IS required.
  const showLoopTemplate = LOOP_FIRING_TYPES.has(type) || type === "github_event";
  const repoRequired = type === "schedule" || type === "github_event";

  // ── Build config ────────────────────────────────────────────────────────────
  function buildConfig(): Record<string, unknown> {
    switch (type) {
      case "webhook":
        return {};
      case "schedule":
        return { cron, action: buildLoopTemplate(template) };
      case "github_event":
        // The event mapping overrides the preset at fire time; we persist a sensible
        // default so the shape validates. repoPath + instruction ARE honoured.
        return {
          repository: ghRepo,
          events: ghEvents,
          action: buildLoopTemplate({ ...template, preset: "diff-pr-review" }),
        };
      case "file_change":
        return { watchPath, patterns: filePatterns, action: buildLoopTemplate(template) };
    }
  }

  // ── Validation ──────────────────────────────────────────────────────────────
  function valid(): boolean {
    return isTriggerFormValid({
      type,
      cron,
      ghRepo,
      ghEvents,
      watchPath,
      preset: template.preset,
      repoPath: template.repoPath,
    });
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid()) return;

    if (isEdit && trigger) {
      updateTrigger.mutate(
        { id: trigger.id, type, config: buildConfig() as never, enabled },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      const payload: InsertTrigger & { _plainSecret?: string } = {
        type,
        config: buildConfig() as never,
        enabled,
        _plainSecret: webhookSecret || undefined,
      };
      createTrigger.mutate(payload, {
        onSuccess: (created) => {
          // Both webhook and github_event triggers get a synthesized URL; reveal it
          // (+ the secret to paste into GitHub) when a secret was set.
          if (
            (type === "webhook" || type === "github_event") &&
            created.webhookUrl &&
            webhookSecret
          ) {
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
                <SelectItem value="schedule" className="text-xs">Schedule (Cron)</SelectItem>
                <SelectItem value="file_change" className="text-xs">File Change</SelectItem>
                <SelectItem value="webhook" className="text-xs">Webhook</SelectItem>
                <SelectItem value="github_event" className="text-xs">GitHub Event</SelectItem>
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
              secret={webhookSecret}
              onSecretChange={setWebhookSecret}
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

          {/* Loop template (schedule + file_change + github_event) */}
          {showLoopTemplate && (
            <LoopTemplateFields
              state={template}
              workspaces={workspaces}
              repoRequired={repoRequired}
              hidePreset={type === "github_event"}
              onChange={(patch) => setTemplate((prev) => ({ ...prev, ...patch }))}
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
              disabled={isPending || !valid()}
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
