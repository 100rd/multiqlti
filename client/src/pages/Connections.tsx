import { useState, useId, useCallback } from "react";
import { useRoute } from "wouter";
import {
  Plus,
  Loader2,
  Plug,
  Trash2,
  RotateCcw,
  CheckCircle2,
  XCircle,
  FlaskConical,
  ChevronLeft,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import {
  useConnections,
  useCreateConnection,
  useUpdateConnection,
  useDeleteConnection,
  useTestConnection,
} from "@/hooks/use-connections";
import type {
  WorkspaceConnection,
  ConnectionType,
  ConnectionStatus,
} from "@shared/types";
import { cn } from "@/lib/utils";

// ─── Types & constants ────────────────────────────────────────────────────────

const CONNECTION_TYPES_INFO: Record<
  ConnectionType,
  { label: string; description: string; icon: string }
> = {
  gitlab: {
    label: "GitLab",
    description: "Connect to GitLab repositories and CI/CD",
    icon: "GL",
  },
  github: {
    label: "GitHub",
    description: "Connect to GitHub repositories and Actions",
    icon: "GH",
  },
  kubernetes: {
    label: "Kubernetes",
    description: "Manage cluster resources via kubectl",
    icon: "K8s",
  },
  aws: {
    label: "AWS",
    description: "Access AWS services with IAM credentials",
    icon: "AWS",
  },
  jira: {
    label: "Jira",
    description: "Sync issues and projects from Jira",
    icon: "JR",
  },
  grafana: {
    label: "Grafana",
    description: "Query metrics and dashboards from Grafana",
    icon: "GF",
  },
  generic_mcp: {
    label: "Generic MCP",
    description: "Connect any Model Context Protocol endpoint",
    icon: "MCP",
  },
};

const STATUS_BADGE: Record<
  ConnectionStatus,
  { label: string; className: string }
> = {
  active: {
    label: "Active",
    className:
      "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
  },
  inactive: {
    label: "Inactive",
    className: "bg-muted text-muted-foreground border-border",
  },
  error: {
    label: "Error",
    className:
      "bg-destructive/10 text-destructive border-destructive/30",
  },
};

// ─── Schema-driven field definitions ─────────────────────────────────────────
// Each type declares its config fields and secret fields separately.

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "url" | "email" | "number" | "boolean";
  placeholder?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
}

const CONFIG_FIELDS: Record<ConnectionType, FieldDef[]> = {
  gitlab: [
    {
      key: "host",
      label: "Host URL",
      type: "url",
      placeholder: "https://gitlab.com",
      required: true,
      defaultValue: "https://gitlab.com",
    },
    {
      key: "projectId",
      label: "Project ID",
      type: "text",
      placeholder: "optional",
    },
    {
      key: "groupPath",
      label: "Group Path",
      type: "text",
      placeholder: "optional",
    },
  ],
  github: [
    {
      key: "host",
      label: "API Host URL",
      type: "url",
      placeholder: "https://api.github.com",
      required: true,
      defaultValue: "https://api.github.com",
    },
    {
      key: "owner",
      label: "Owner / Organisation",
      type: "text",
      placeholder: "acme-corp",
      required: true,
    },
    {
      key: "repo",
      label: "Repository",
      type: "text",
      placeholder: "optional",
    },
    {
      key: "appId",
      label: "GitHub App ID",
      type: "text",
      placeholder: "optional",
    },
  ],
  kubernetes: [
    {
      key: "server",
      label: "API Server URL",
      type: "url",
      placeholder: "https://k8s.example.com:6443",
      required: true,
    },
    {
      key: "namespace",
      label: "Default Namespace",
      type: "text",
      placeholder: "default",
      defaultValue: "default",
    },
  ],
  aws: [
    {
      key: "region",
      label: "AWS Region",
      type: "text",
      placeholder: "us-east-1",
      required: true,
    },
    {
      key: "accountId",
      label: "Account ID",
      type: "text",
      placeholder: "optional",
    },
    {
      key: "roleArn",
      label: "Role ARN",
      type: "text",
      placeholder: "arn:aws:iam::123456789012:role/MyRole — optional",
    },
  ],
  jira: [
    {
      key: "host",
      label: "Jira Host URL",
      type: "url",
      placeholder: "https://myorg.atlassian.net",
      required: true,
    },
    {
      key: "email",
      label: "Account Email",
      type: "email",
      placeholder: "you@example.com — optional",
    },
    {
      key: "projectKey",
      label: "Default Project Key",
      type: "text",
      placeholder: "PROJ — optional",
    },
  ],
  grafana: [
    {
      key: "host",
      label: "Grafana Host URL",
      type: "url",
      placeholder: "https://grafana.example.com",
      required: true,
    },
    {
      key: "orgId",
      label: "Organisation ID",
      type: "number",
      placeholder: "1",
      defaultValue: 1,
    },
  ],
  generic_mcp: [
    {
      key: "endpoint",
      label: "MCP Endpoint URL",
      type: "url",
      placeholder: "https://mcp.example.com/v1",
      required: true,
    },
    {
      key: "description",
      label: "Description",
      type: "text",
      placeholder: "optional",
    },
  ],
};

// Secret field keys per connection type (masked password inputs)
const SECRET_FIELDS: Record<ConnectionType, FieldDef[]> = {
  gitlab: [
    {
      key: "token",
      label: "Personal Access Token",
      type: "text",
      placeholder: "glpat-xxxxxxxxxxxxxxxxxxxx",
      required: true,
    },
  ],
  github: [
    {
      key: "token",
      label: "Personal Access Token / App Private Key",
      type: "text",
      placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx",
      required: true,
    },
  ],
  kubernetes: [
    {
      key: "token",
      label: "Service Account Token",
      type: "text",
      placeholder: "eyJhbGciOi...",
    },
    {
      key: "clientCert",
      label: "Client Certificate (PEM)",
      type: "text",
      placeholder: "-----BEGIN CERTIFICATE-----",
    },
    {
      key: "clientKey",
      label: "Client Private Key (PEM)",
      type: "text",
      placeholder: "-----BEGIN PRIVATE KEY-----",
    },
  ],
  aws: [
    {
      key: "accessKeyId",
      label: "Access Key ID",
      type: "text",
      placeholder: "AKIAIOSFODNN7EXAMPLE",
    },
    {
      key: "secretAccessKey",
      label: "Secret Access Key",
      type: "text",
      placeholder: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
  ],
  jira: [
    {
      key: "apiToken",
      label: "API Token",
      type: "text",
      placeholder: "ATATT3x...",
      required: true,
    },
  ],
  grafana: [
    {
      key: "serviceAccountToken",
      label: "Service Account Token",
      type: "text",
      placeholder: "glsa_xxxxxxxxxxxxxxxxxxxx",
      required: true,
    },
  ],
  generic_mcp: [
    {
      key: "apiKey",
      label: "API Key",
      type: "text",
      placeholder: "sk-...",
    },
  ],
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const { label, className } = STATUS_BADGE[status] ?? STATUS_BADGE.inactive;
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] font-semibold border px-1.5 py-0.5 rounded", className)}
    >
      {label}
    </Badge>
  );
}

function TypePicker({
  onSelect,
}: {
  onSelect: (type: ConnectionType) => void;
}) {
  const types = Object.entries(CONNECTION_TYPES_INFO) as [
    ConnectionType,
    (typeof CONNECTION_TYPES_INFO)[ConnectionType],
  ][];

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-4">
        Choose the service you want to connect to this workspace.
      </p>
      <div className="grid grid-cols-2 gap-3" role="list" aria-label="Connection type picker">
        {types.map(([type, info]) => (
          <button
            key={type}
            role="listitem"
            onClick={() => onSelect(type)}
            className="flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Select ${info.label}`}
          >
            <span className="w-8 h-8 rounded bg-muted flex items-center justify-center text-[10px] font-bold font-mono text-muted-foreground shrink-0">
              {info.icon}
            </span>
            <div>
              <p className="text-sm font-medium">{info.label}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {info.description}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Masked secret input ──────────────────────────────────────────────────────

interface SecretInputProps {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (val: string) => void;
  hasExisting?: boolean;
}

function SecretInput({
  id,
  label,
  value,
  placeholder,
  onChange,
  hasExisting,
}: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
        {hasExisting && !value && (
          <span className="ml-2 text-[10px] text-muted-foreground font-normal">
            (secret already stored — paste to rotate)
          </span>
        )}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            hasExisting && !value
              ? "Leave blank to keep existing secret"
              : (placeholder ?? "")
          }
          className="pr-9 text-sm font-mono"
          autoComplete="new-password"
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? "Hide secret" : "Reveal secret"}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {revealed ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Schema-driven connection form ────────────────────────────────────────────

interface ConnectionFormProps {
  type: ConnectionType;
  initial?: WorkspaceConnection;
  onBack?: () => void;
  onSubmit: (
    name: string,
    config: Record<string, unknown>,
    secrets: Record<string, string>,
  ) => void;
  isSubmitting: boolean;
}

function ConnectionForm({
  type,
  initial,
  onBack,
  onSubmit,
  isSubmitting,
}: ConnectionFormProps) {
  const typeInfo = CONNECTION_TYPES_INFO[type];
  const configFields = CONFIG_FIELDS[type];
  const secretFields = SECRET_FIELDS[type];

  // Initialise config state from existing connection or defaults
  const buildDefaultConfig = useCallback(() => {
    const defaults: Record<string, string> = {};
    for (const f of configFields) {
      const existing =
        initial?.config[f.key] !== undefined
          ? String(initial.config[f.key])
          : f.defaultValue !== undefined
            ? String(f.defaultValue)
            : "";
      defaults[f.key] = existing;
    }
    return defaults;
  }, [configFields, initial]);

  const [name, setName] = useState(initial?.name ?? "");
  const [config, setConfig] = useState<Record<string, string>>(buildDefaultConfig);
  const [secrets, setSecrets] = useState<Record<string, string>>(() => {
    const s: Record<string, string> = {};
    for (const f of secretFields) s[f.key] = "";
    return s;
  });

  const formId = useId();

  function setConfigField(key: string, value: string) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function setSecretField(key: string, value: string) {
    setSecrets((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Build typed config — omit empty optional fields
    const builtConfig: Record<string, unknown> = {};
    for (const f of configFields) {
      const val = config[f.key];
      if (f.type === "number") {
        const num = Number(val);
        if (!isNaN(num)) builtConfig[f.key] = num;
      } else if (val !== "") {
        builtConfig[f.key] = val;
      }
    }

    // Only include secrets that were explicitly entered
    const builtSecrets: Record<string, string> = {};
    for (const f of secretFields) {
      const val = secrets[f.key];
      if (val.trim() !== "") builtSecrets[f.key] = val.trim();
    }

    onSubmit(name.trim(), builtConfig, builtSecrets);
  }

  const isNameValid = name.trim().length > 0;
  const areRequiredConfigFieldsFilled = configFields
    .filter((f) => f.required)
    .every((f) => config[f.key]?.trim() !== "");
  const canSubmit = isNameValid && areRequiredConfigFieldsFilled && !isSubmitting;

  return (
    <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-5">
      {/* Back + type indicator */}
      {onBack && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to type picker"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs font-medium">{typeInfo.label}</span>
        </div>
      )}

      {/* Name */}
      <div className="space-y-1.5">
        <Label htmlFor={`${formId}-name`} className="text-xs font-medium">
          Connection Name <span className="text-destructive">*</span>
        </Label>
        <Input
          id={`${formId}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`My ${typeInfo.label} Connection`}
          required
          aria-required="true"
          className="text-sm"
        />
      </div>

      {/* Config fields */}
      <fieldset className="space-y-3">
        <legend className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Configuration
        </legend>
        {configFields.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={`${formId}-cfg-${f.key}`} className="text-xs font-medium">
              {f.label}
              {f.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            <Input
              id={`${formId}-cfg-${f.key}`}
              type={f.type === "number" ? "number" : "text"}
              value={config[f.key] ?? ""}
              onChange={(e) => setConfigField(f.key, e.target.value)}
              placeholder={f.placeholder}
              required={f.required}
              aria-required={f.required ? "true" : undefined}
              className="text-sm"
            />
          </div>
        ))}
      </fieldset>

      {/* Secret fields */}
      {secretFields.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Secrets{" "}
            <span className="normal-case font-normal text-muted-foreground/70">
              — paste once, never shown again
            </span>
          </legend>
          {secretFields.map((f) => (
            <SecretInput
              key={f.key}
              id={`${formId}-sec-${f.key}`}
              label={f.label}
              value={secrets[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(val) => setSecretField(f.key, val)}
              hasExisting={initial?.hasSecrets ?? false}
            />
          ))}
        </fieldset>
      )}

      {/* Submit */}
      <Button
        type="submit"
        size="sm"
        className="w-full"
        disabled={!canSubmit}
        aria-disabled={!canSubmit}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
            {initial ? "Saving…" : "Creating…"}
          </>
        ) : initial ? (
          "Save Changes"
        ) : (
          "Create & Test Connection"
        )}
      </Button>
    </form>
  );
}

// ─── Test result dialog ───────────────────────────────────────────────────────

interface TestResultDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  result: { ok: boolean; latencyMs: number | null; details: string } | null;
  connectionName: string;
  isTesting: boolean;
}

function TestResultDialog({
  open,
  onOpenChange,
  result,
  connectionName,
  isTesting,
}: TestResultDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Connectivity Test — {connectionName}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Result of the connectivity test for {connectionName}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          {isTesting && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Running connectivity check…
            </div>
          )}

          {!isTesting && result && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {result.ok ? (
                  <>
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
                    <span className="text-sm font-medium text-emerald-600">
                      Connection successful
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
                    <span className="text-sm font-medium text-destructive">
                      Connection failed
                    </span>
                  </>
                )}
                {result.latencyMs !== null && (
                  <span className="ml-auto text-xs text-muted-foreground font-mono">
                    {result.latencyMs} ms
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed bg-muted rounded p-2 font-mono">
                {result.details}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="text-xs"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete confirmation dialog ───────────────────────────────────────────────

interface DeleteConfirmProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connection: WorkspaceConnection | null;
  onConfirm: () => void;
  isDeleting: boolean;
}

function DeleteConfirmDialog({
  open,
  onOpenChange,
  connection,
  onConfirm,
  isDeleting,
}: DeleteConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Delete Connection</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground mt-1">
            Are you sure you want to delete{" "}
            <span className="font-semibold text-foreground">
              {connection?.name}
            </span>
            ? This action cannot be undone. Any stored secrets will be permanently removed.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={onConfirm}
            disabled={isDeleting}
            className="text-xs"
          >
            {isDeleting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add / Edit Dialog ────────────────────────────────────────────────────────

type AddStep = "pick-type" | "fill-form";

interface AddEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  editingConnection?: WorkspaceConnection | null;
}

function AddEditDialog({
  open,
  onOpenChange,
  workspaceId,
  editingConnection,
}: AddEditDialogProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<AddStep>(
    editingConnection ? "fill-form" : "pick-type",
  );
  const [selectedType, setSelectedType] = useState<ConnectionType | null>(
    editingConnection?.type ?? null,
  );

  const createConnection = useCreateConnection(workspaceId);
  const updateConnection = useUpdateConnection(workspaceId);
  const testConnection = useTestConnection(workspaceId);

  // Reset state when dialog opens/closes
  function handleOpenChange(v: boolean) {
    if (!v) {
      setStep(editingConnection ? "fill-form" : "pick-type");
      setSelectedType(editingConnection?.type ?? null);
      createConnection.reset();
      updateConnection.reset();
    }
    onOpenChange(v);
  }

  function handleTypeSelect(type: ConnectionType) {
    setSelectedType(type);
    setStep("fill-form");
  }

  async function handleFormSubmit(
    name: string,
    config: Record<string, unknown>,
    secrets: Record<string, string>,
  ) {
    try {
      if (editingConnection) {
        await updateConnection.mutateAsync({
          cid: editingConnection.id,
          name,
          config,
          secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
        });
        toast({ title: "Connection updated", description: name });
      } else {
        const created = await createConnection.mutateAsync({
          type: selectedType!,
          name,
          config,
          secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
        });

        // Auto-test on create
        try {
          const testResult = await testConnection.mutateAsync(created.id);
          if (testResult.ok) {
            toast({
              title: "Connection created and verified",
              description: `${name} — ${testResult.latencyMs ?? ""}ms`,
            });
          } else {
            toast({
              title: "Connection created (test failed)",
              description: testResult.details,
              variant: "destructive",
            });
          }
        } catch {
          toast({
            title: "Connection created",
            description: `${name} — auto-test could not run`,
          });
        }
      }
      handleOpenChange(false);
    } catch (err) {
      toast({
        title: editingConnection ? "Update failed" : "Create failed",
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }

  const isSubmitting =
    createConnection.isPending ||
    updateConnection.isPending ||
    testConnection.isPending;

  const title = editingConnection
    ? `Edit — ${editingConnection.name}`
    : step === "pick-type"
      ? "Add Connection"
      : `Add ${selectedType ? CONNECTION_TYPES_INFO[selectedType].label : ""} Connection`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {editingConnection
              ? `Edit connection ${editingConnection.name}`
              : "Add a new external connection to this workspace"}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-1">
          {step === "pick-type" ? (
            <TypePicker onSelect={handleTypeSelect} />
          ) : (
            selectedType && (
              <ConnectionForm
                type={selectedType}
                initial={editingConnection ?? undefined}
                onBack={
                  editingConnection
                    ? undefined
                    : () => setStep("pick-type")
                }
                onSubmit={handleFormSubmit}
                isSubmitting={isSubmitting}
              />
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Connections row ──────────────────────────────────────────────────────────

interface ConnectionRowProps {
  connection: WorkspaceConnection;
  workspaceId: string;
  isAdmin: boolean;
  onEdit: (c: WorkspaceConnection) => void;
  onDelete: (c: WorkspaceConnection) => void;
  onTest: (c: WorkspaceConnection) => void;
  onRotate: (c: WorkspaceConnection) => void;
  isTesting: boolean;
}

function ConnectionRow({
  connection,
  isAdmin,
  onEdit,
  onDelete,
  onTest,
  onRotate,
  isTesting,
}: ConnectionRowProps) {
  const typeInfo = CONNECTION_TYPES_INFO[connection.type] ?? {
    label: connection.type,
    icon: "?",
  };

  const lastTested = connection.lastTestedAt
    ? new Date(connection.lastTestedAt).toLocaleString()
    : "Never";

  return (
    <TableRow>
      <TableCell className="py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="w-7 h-7 rounded bg-muted flex items-center justify-center text-[9px] font-bold font-mono text-muted-foreground shrink-0">
            {typeInfo.icon}
          </span>
          <div>
            <p className="text-xs font-medium">{connection.name}</p>
            {connection.hasSecrets && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Has stored secrets
              </p>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="py-2.5">
        <span className="text-xs text-muted-foreground">{typeInfo.label}</span>
      </TableCell>
      <TableCell className="py-2.5">
        <StatusBadge status={connection.status} />
      </TableCell>
      <TableCell className="py-2.5">
        <span className="text-[10px] text-muted-foreground font-mono">{lastTested}</span>
      </TableCell>
      <TableCell className="py-2.5 text-right">
        <div className="flex items-center justify-end gap-1">
          {/* Test */}
          <button
            onClick={() => onTest(connection)}
            disabled={isTesting}
            aria-label={`Test connection ${connection.name}`}
            title="Run connectivity test"
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            {isTesting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FlaskConical className="h-3.5 w-3.5" />
            )}
          </button>

          {/* Admin-only actions */}
          {isAdmin && (
            <>
              {/* Rotate secrets */}
              {connection.hasSecrets && (
                <button
                  onClick={() => onRotate(connection)}
                  aria-label={`Rotate secrets for ${connection.name}`}
                  title="Rotate secrets"
                  className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}

              {/* Edit */}
              <button
                onClick={() => onEdit(connection)}
                aria-label={`Edit connection ${connection.name}`}
                title="Edit connection"
                className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-xs font-medium"
              >
                Edit
              </button>

              {/* Delete */}
              <button
                onClick={() => onDelete(connection)}
                aria-label={`Delete connection ${connection.name}`}
                title="Delete connection"
                className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Connections() {
  const [, params] = useRoute<{ id: string }>("/workspaces/:id/connections");
  const workspaceId = params?.id ?? "";

  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // Filters
  const [filterType, setFilterType] = useState<ConnectionType | "all">("all");
  const [filterStatus, setFilterStatus] = useState<ConnectionStatus | "all">("all");

  // Dialog states
  const [addOpen, setAddOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<WorkspaceConnection | null>(null);
  const [deletingConnection, setDeletingConnection] =
    useState<WorkspaceConnection | null>(null);
  const [testingConnection, setTestingConnection] =
    useState<WorkspaceConnection | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs: number | null;
    details: string;
  } | null>(null);
  const [testDialogOpen, setTestDialogOpen] = useState(false);

  // API hooks
  const { data: connectionsData, isLoading, error } = useConnections(workspaceId);
  const deleteConnection = useDeleteConnection(workspaceId);
  const testConnection = useTestConnection(workspaceId);
  const updateConnection = useUpdateConnection(workspaceId);

  const connections: WorkspaceConnection[] = Array.isArray(connectionsData)
    ? connectionsData
    : [];

  // Apply filters
  const filtered = connections.filter((c) => {
    if (filterType !== "all" && c.type !== filterType) return false;
    if (filterStatus !== "all" && c.status !== filterStatus) return false;
    return true;
  });

  // ─── Handlers ──────────────────────────────────────────────────────────────

  function handleEdit(c: WorkspaceConnection) {
    setEditingConnection(c);
  }

  function handleEditClose(v: boolean) {
    if (!v) setEditingConnection(null);
  }

  function handleDelete(c: WorkspaceConnection) {
    setDeletingConnection(c);
  }

  async function handleDeleteConfirm() {
    if (!deletingConnection) return;
    try {
      await deleteConnection.mutateAsync(deletingConnection.id);
      toast({ title: "Connection deleted", description: deletingConnection.name });
      setDeletingConnection(null);
    } catch (err) {
      toast({
        title: "Delete failed",
        description: (err as Error).message,
        variant: "destructive",
      });
    }
  }

  async function handleTest(c: WorkspaceConnection) {
    setTestingConnection(c);
    setTestResult(null);
    setTestDialogOpen(true);
    try {
      const result = await testConnection.mutateAsync(c.id);
      setTestResult(result);
      if (result.ok) {
        toast({ title: `${c.name} — connected`, description: `${result.latencyMs ?? ""}ms` });
      } else {
        toast({
          title: `${c.name} — test failed`,
          description: result.details,
          variant: "destructive",
        });
      }
    } catch (err) {
      const msg = (err as Error).message;
      setTestResult({ ok: false, latencyMs: null, details: msg });
      toast({ title: "Test failed", description: msg, variant: "destructive" });
    } finally {
      setTestingConnection(null);
    }
  }

  function handleRotate(c: WorkspaceConnection) {
    // Open the edit dialog focused on secrets — the form will show "rotate" UX
    setEditingConnection(c);
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div>
          <h2 className="text-sm font-semibold">External Connections</h2>
          <p className="text-xs text-muted-foreground">
            Manage integrations and credentials for this workspace
          </p>
        </div>
        {isAdmin && (
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="h-3 w-3 mr-1.5" />
            Add Connection
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="border-b border-border px-6 py-2.5 flex items-center gap-3 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Filter:
        </span>

        <Select
          value={filterType}
          onValueChange={(v) => setFilterType(v as ConnectionType | "all")}
        >
          <SelectTrigger className="h-7 text-xs w-36" aria-label="Filter by type">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              All types
            </SelectItem>
            {(Object.entries(CONNECTION_TYPES_INFO) as [ConnectionType, (typeof CONNECTION_TYPES_INFO)[ConnectionType]][]).map(
              ([type, info]) => (
                <SelectItem key={type} value={type} className="text-xs">
                  {info.label}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>

        <Select
          value={filterStatus}
          onValueChange={(v) =>
            setFilterStatus(v as ConnectionStatus | "all")
          }
        >
          <SelectTrigger className="h-7 text-xs w-32" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              All statuses
            </SelectItem>
            <SelectItem value="active" className="text-xs">
              Active
            </SelectItem>
            <SelectItem value="inactive" className="text-xs">
              Inactive
            </SelectItem>
            <SelectItem value="error" className="text-xs">
              Error
            </SelectItem>
          </SelectContent>
        </Select>

        {(filterType !== "all" || filterStatus !== "all") && (
          <button
            onClick={() => {
              setFilterType("all");
              setFilterStatus("all");
            }}
            className="text-[10px] text-muted-foreground hover:text-foreground underline transition-colors"
          >
            Clear
          </button>
        )}

        <span className="ml-auto text-[10px] text-muted-foreground">
          {filtered.length} / {connections.length}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading connections…
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center py-16">
            <p className="text-sm text-destructive">
              Failed to load connections: {(error as Error).message}
            </p>
          </div>
        )}

        {!isLoading && !error && connections.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Plug className="h-10 w-10 text-muted-foreground/40 mb-4" />
            <p className="text-sm font-medium text-muted-foreground">
              No connections yet
            </p>
            <p className="text-xs text-muted-foreground mt-1 mb-6">
              Connect external services to this workspace.
            </p>
            {isAdmin && (
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-3 w-3 mr-1.5" />
                Add Connection
              </Button>
            )}
          </div>
        )}

        {!isLoading && !error && connections.length > 0 && (
          <>
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-sm text-muted-foreground">
                  No connections match the current filters.
                </p>
                <button
                  onClick={() => {
                    setFilterType("all");
                    setFilterStatus("all");
                  }}
                  className="text-xs text-primary mt-2 hover:underline"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="px-6 py-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[10px] uppercase tracking-wider w-64">
                        Name
                      </TableHead>
                      <TableHead className="text-[10px] uppercase tracking-wider w-28">
                        Type
                      </TableHead>
                      <TableHead className="text-[10px] uppercase tracking-wider w-24">
                        Status
                      </TableHead>
                      <TableHead className="text-[10px] uppercase tracking-wider">
                        Last Tested
                      </TableHead>
                      <TableHead className="text-[10px] uppercase tracking-wider text-right w-40">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((c) => (
                      <ConnectionRow
                        key={c.id}
                        connection={c}
                        workspaceId={workspaceId}
                        isAdmin={isAdmin}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onTest={handleTest}
                        onRotate={handleRotate}
                        isTesting={
                          testConnection.isPending &&
                          testingConnection?.id === c.id
                        }
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Add dialog */}
      <AddEditDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        workspaceId={workspaceId}
      />

      {/* Edit dialog */}
      {editingConnection && (
        <AddEditDialog
          open={!!editingConnection}
          onOpenChange={handleEditClose}
          workspaceId={workspaceId}
          editingConnection={editingConnection}
        />
      )}

      {/* Delete confirmation */}
      <DeleteConfirmDialog
        open={!!deletingConnection}
        onOpenChange={(v) => { if (!v) setDeletingConnection(null); }}
        connection={deletingConnection}
        onConfirm={handleDeleteConfirm}
        isDeleting={deleteConnection.isPending}
      />

      {/* Test result dialog */}
      <TestResultDialog
        open={testDialogOpen}
        onOpenChange={(v) => {
          setTestDialogOpen(v);
          if (!v) setTestResult(null);
        }}
        result={testResult}
        connectionName={
          testingConnection?.name ??
          (testResult ? "Connection" : "")
        }
        isTesting={testConnection.isPending}
      />

      {/* Hidden rotate mutation — only needed to trigger the update */}
      {/* (rotate reuses the edit dialog, which handles secrets rotation) */}
      <div aria-hidden="true" className="hidden">
        {updateConnection.isPending && "rotating"}
      </div>
    </div>
  );
}

// ─── Exported helpers for unit tests ─────────────────────────────────────────

/** Returns a human-readable label for a connection status. */
export function statusLabel(status: ConnectionStatus): string {
  return STATUS_BADGE[status]?.label ?? status;
}

/** Returns the connection type display label. */
export function typeLabel(type: ConnectionType): string {
  return CONNECTION_TYPES_INFO[type]?.label ?? type;
}

/** Validates that a name is non-empty and required config fields are present. */
export function isConnectionFormValid(
  name: string,
  type: ConnectionType,
  config: Record<string, string>,
): boolean {
  if (!name.trim()) return false;
  const fields = CONFIG_FIELDS[type] ?? [];
  return fields
    .filter((f) => f.required)
    .every((f) => (config[f.key] ?? "").trim() !== "");
}

/** Returns the secret fields for a given connection type. */
export function getSecretFields(type: ConnectionType): FieldDef[] {
  return SECRET_FIELDS[type] ?? [];
}

/** Returns the config fields for a given connection type. */
export function getConfigFields(type: ConnectionType): FieldDef[] {
  return CONFIG_FIELDS[type] ?? [];
}
