/**
 * ArgocdSettings — Settings section for Infrastructure → ArgoCD connection.
 * Phase 6.10.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Server,
  Eye,
  EyeOff,
  Save,
  Plug,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useArgoCdConfig,
  useSaveArgoCdConfig,
  useDeleteArgoCdConfig,
  useTestArgoCd,
  type ArgoCdTestResult,
} from "@/hooks/useArgoCdSettings";

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: "connected" | "error" | "unknown" | undefined }) {
  if (status === "connected") {
    return (
      <Badge variant="outline" className="text-green-600 border-green-300 bg-green-50 gap-1">
        <CheckCircle2 className="h-3 w-3" /> Connected
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="outline" className="text-red-600 border-red-300 bg-red-50 gap-1">
        <XCircle className="h-3 w-3" /> Error
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground gap-1">
      <AlertCircle className="h-3 w-3" /> Not configured
    </Badge>
  );
}

// ─── Test Result Panel ────────────────────────────────────────────────────────

function TestResultPanel({ result }: { result: ArgoCdTestResult }) {
  if (result.ok) {
    return (
      <div className="p-3 rounded-md bg-green-50 border border-green-200 text-sm">
        <div className="flex items-center gap-2 text-green-700 font-medium mb-1">
          <CheckCircle2 className="h-4 w-4" />
          Connected — {result.applicationCount} application(s) found ({result.latencyMs}ms)
        </div>
        {result.applications.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {result.applications.map((name) => (
              <Badge key={name} variant="secondary" className="text-xs">
                {name}
              </Badge>
            ))}
            {result.applicationCount > result.applications.length && (
              <Badge variant="secondary" className="text-xs text-muted-foreground">
                +{result.applicationCount - result.applications.length} more
              </Badge>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-3 rounded-md bg-red-50 border border-red-200 text-sm">
      <div className="flex items-center gap-2 text-red-700 font-medium">
        <XCircle className="h-4 w-4" />
        Connection failed: {result.error ?? "Unknown error"}
      </div>
    </div>
  );
}

// ─── Inner content (shared between noCard and Card modes) ─────────────────────

interface ArgocdSettingsContentProps {
  className?: string;
}

function ArgocdSettingsContent({ className }: ArgocdSettingsContentProps) {
  const { data: config, isLoading } = useArgoCdConfig();
  const saveConfig = useSaveArgoCdConfig();
  const deleteConfig = useDeleteArgoCdConfig();
  const testConnection = useTestArgoCd();

  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [verifySsl, setVerifySsl] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [testResult, setTestResult] = useState<ArgoCdTestResult | null>(null);

  const isConfigured = config?.configured ?? false;
  const isSaving = saveConfig.isPending;
  const isDeleting = deleteConfig.isPending;
  const isTesting = testConnection.isPending;

  function handleSave() {
    const urlToSave = serverUrl.trim() || (config?.serverUrl ?? "");
    if (!urlToSave) return;

    const payload: Parameters<typeof saveConfig.mutate>[0] = {
      serverUrl: urlToSave,
      verifySsl,
      enabled,
    };
    if (token.trim()) {
      payload.token = token.trim();
    }

    saveConfig.mutate(payload, {
      onSuccess: () => {
        setToken("");
        setTestResult(null);
      },
    });
  }

  function handleDelete() {
    if (!window.confirm("Remove ArgoCD configuration? This will disconnect the MCP integration.")) {
      return;
    }
    deleteConfig.mutate(undefined, {
      onSuccess: () => {
        setServerUrl("");
        setToken("");
        setTestResult(null);
      },
    });
  }

  function handleTest() {
    setTestResult(null);
    testConnection.mutate(undefined, {
      onSuccess: (result) => setTestResult(result),
      onError: (err) =>
        setTestResult({ ok: false, error: err.message, applicationCount: 0, applications: [], latencyMs: 0 }),
    });
  }

  return (
    <div className={cn("space-y-4", className)}>
      {/* Status Row */}
      {!isLoading && (
        <div className="flex items-center gap-3">
          <StatusBadge status={config?.healthStatus} />
          {config?.lastHealthCheckAt && (
            <span className="text-xs text-muted-foreground">
              Last checked: {new Date(config.lastHealthCheckAt).toLocaleString()}
            </span>
          )}
          {config?.source === "env" && (
            <Badge variant="secondary" className="text-xs">via env vars</Badge>
          )}
        </div>
      )}

      {/* Health error */}
      {config?.healthStatus === "error" && config.healthError && (
        <div className="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-700">
          {config.healthError}
        </div>
      )}

      {/* Form */}
      <div className="space-y-3">
        {/* Server URL */}
        <div className="space-y-1">
          <Label htmlFor="argocd-server-url">ArgoCD Server URL</Label>
          <Input
            id="argocd-server-url"
            type="url"
            placeholder={config?.serverUrl ?? "https://argocd.example.com"}
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            disabled={config?.source === "env"}
          />
          {config?.source === "env" && (
            <p className="text-xs text-muted-foreground">Configured via ARGOCD_SERVER_URL environment variable.</p>
          )}
        </div>

        {/* Auth Token */}
        <div className="space-y-1">
          <Label htmlFor="argocd-token">Authentication Token</Label>
          <div className="relative">
            <Input
              id="argocd-token"
              type={showToken ? "text" : "password"}
              placeholder={isConfigured ? "••••••••  (leave blank to keep existing token)" : "Enter ArgoCD API token"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="pr-10"
              disabled={config?.source === "env"}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="absolute right-0 top-0 h-full px-3"
              onClick={() => setShowToken((v) => !v)}
              tabIndex={-1}
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Token is stored encrypted (AES-256-GCM). Leave blank to keep the existing token.
          </p>
        </div>

        {/* Verify SSL */}
        <div className="flex items-center gap-2">
          <Switch
            id="argocd-verify-ssl"
            checked={verifySsl}
            onCheckedChange={setVerifySsl}
            disabled={config?.source === "env"}
          />
          <Label htmlFor="argocd-verify-ssl" className="cursor-pointer">
            Verify SSL Certificate
          </Label>
          {!verifySsl && (
            <Badge variant="outline" className="text-yellow-600 border-yellow-300 text-xs">
              SSL disabled — use only for development
            </Badge>
          )}
        </div>

        {/* Enabled */}
        <div className="flex items-center gap-2">
          <Switch
            id="argocd-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={config?.source === "env"}
          />
          <Label htmlFor="argocd-enabled" className="cursor-pointer">
            Enable ArgoCD integration
          </Label>
        </div>
      </div>

      {/* Action Buttons */}
      {config?.source !== "env" && (
        <div className="flex gap-2 pt-2">
          <Button
            onClick={handleSave}
            disabled={isSaving || isDeleting}
            size="sm"
            className={cn(saveConfig.isSuccess && "bg-green-600 hover:bg-green-700")}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            {isSaving ? "Saving…" : saveConfig.isSuccess ? "Saved" : "Save"}
          </Button>

          <Button
            variant="outline"
            onClick={handleTest}
            disabled={isTesting || isDeleting || (!isConfigured && !serverUrl.trim())}
            size="sm"
          >
            {isTesting ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Plug className="h-4 w-4 mr-1" />
            )}
            {isTesting ? "Testing…" : "Test Connection"}
          </Button>

          {isConfigured && (
            <Button
              variant="ghost"
              onClick={handleDelete}
              disabled={isSaving || isDeleting}
              size="sm"
              className="text-destructive hover:text-destructive"
            >
              {isDeleting ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              Remove
            </Button>
          )}
        </div>
      )}

      {/* env override test button */}
      {config?.source === "env" && (
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={isTesting}
          size="sm"
        >
          {isTesting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plug className="h-4 w-4 mr-1" />}
          Test Connection
        </Button>
      )}

      {/* Error from save */}
      {saveConfig.isError && (
        <p className="text-sm text-red-600">{saveConfig.error.message}</p>
      )}

      {/* Test Result */}
      {testResult && <TestResultPanel result={testResult} />}

      {/* Info note */}
      <div className="pt-2 border-t text-xs text-muted-foreground space-y-1">
        <p>
          When connected, the <strong>Infrastructure Monitor</strong> built-in skill becomes available in pipeline stages.
          All K8s resource names are masked before being sent to the LLM.
        </p>
        <p>
          Environment variables: <code className="bg-muted px-1 rounded">ARGOCD_SERVER_URL</code>,{" "}
          <code className="bg-muted px-1 rounded">ARGOCD_TOKEN</code>
        </p>
      </div>
    </div>
  );
}

// ─── Public export ────────────────────────────────────────────────────────────

interface ArgocdSettingsProps {
  /** When true, renders content only (no Card wrapper). Use inside SettingsSection. */
  noCard?: boolean;
}

export function ArgocdSettings({ noCard = false }: ArgocdSettingsProps) {
  if (noCard) {
    return <ArgocdSettingsContent className="p-4" />;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Server className="h-4 w-4" />
          Infrastructure — ArgoCD
        </CardTitle>
        <CardDescription>
          Connect multiqlti to your ArgoCD instance for deployment monitoring via the Infrastructure Monitor skill.
          Cluster names, service names, and pod names are automatically masked before being sent to the LLM.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <ArgocdSettingsContent />
      </CardContent>
    </Card>
  );
}
