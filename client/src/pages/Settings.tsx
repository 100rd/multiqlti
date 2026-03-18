import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Settings as SettingsIcon,
  RefreshCw,
  Plus,
  Trash2,
  Plug,
  Globe,
  Server,
  Cpu,
  CheckCircle2,
  XCircle,
  Loader2,
  Search,
  Cloud,
  Save,
  Eye,
  EyeOff,
  Brain,
  Wrench,
  Terminal,
  Link2,
  Shield,
  ShieldCheck,
} from "lucide-react";
import {
  useModels,
  useUpdateModel,
  useDeleteModel,
  useImportModel,
  useGatewayStatus,
  useDiscoverProviderModels,
  useProbeEndpoint,
  useCreateModel,
  apiRequest,
} from "@/hooks/use-pipeline";
import { cn } from "@/lib/utils";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { ArgocdSettings } from "@/components/settings/ArgocdSettings";
import { SettingsSection } from "@/components/settings/SettingsSection";

type CloudProvider = "anthropic" | "google" | "xai";

interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface ProviderStatus {
  provider: CloudProvider;
  configured: boolean;
  source: "env" | "db" | "none";
  updatedAt: string | null;
}

const CLOUD_PROVIDERS: Array<{
  key: CloudProvider;
  name: string;
  envVar: string;
}> = [
  { key: "anthropic", name: "Anthropic (Claude)", envVar: "ANTHROPIC_API_KEY" },
  { key: "google",    name: "Google (Gemini)",    envVar: "GOOGLE_API_KEY"    },
  { key: "xai",       name: "xAI (Grok)",         envVar: "XAI_API_KEY"       },
];

const PREFERENCE_ROWS = [
  { key: "preferred-language", label: "Preferred Language", placeholder: "e.g. TypeScript" },
  { key: "error-handling-style", label: "Error Handling Style", placeholder: "e.g. throw exceptions, return Result types" },
  { key: "preferred-db", label: "Preferred Database", placeholder: "e.g. PostgreSQL, SQLite" },
  { key: "code-style", label: "Code Style", placeholder: "e.g. functional, OOP" },
  { key: "test-framework", label: "Test Framework", placeholder: "e.g. Jest, Vitest" },
];


// ─── Maintenance Settings ─────────────────────────────────────────────────────

const SCHEDULE_PRESETS = [
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Weekly (Mon 9am)", value: "0 9 * * 1" },
  { label: "Monthly (1st, 9am)", value: "0 9 1 * *" },
];

const SEVERITY_OPTIONS = ["critical", "high", "medium", "low", "info"] as const;

interface MaintenancePolicySummary {
  id: string;
  enabled: boolean;
  schedule: string;
  severityThreshold: string;
}

interface MaintenanceSettingsProps {
  /** When true, renders content only without a Card wrapper. Use inside SettingsSection. */
  noCard?: boolean;
}

function MaintenanceSettings({ noCard = false }: MaintenanceSettingsProps) {
  const qc = useQueryClient();

  const { data: policies, isLoading } = useQuery<MaintenancePolicySummary[]>({
    queryKey: ["/api/maintenance/policies"],
    queryFn: () =>
      apiRequest("GET", "/api/maintenance/policies") as Promise<MaintenancePolicySummary[]>,
  });

  const firstPolicy = policies?.[0] ?? null;

  const [schedule, setSchedule] = useState(SCHEDULE_PRESETS[1].value);
  const [severity, setSeverity] = useState<string>("high");

  const createPolicy = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/maintenance/policies", {
        enabled: true,
        schedule,
        severityThreshold: severity,
        categories: [],
        autoMerge: false,
        notifyChannels: [],
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] }),
  });

  const togglePolicy = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiRequest("PUT", `/api/maintenance/policies/${id}`, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] }),
  });

  const updatePolicy = useMutation({
    mutationFn: ({ id, schedule: s, severityThreshold }: { id: string; schedule: string; severityThreshold: string }) =>
      apiRequest("PUT", `/api/maintenance/policies/${id}`, { schedule: s, severityThreshold }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/maintenance/policies"] }),
  });

  const isEnabled = firstPolicy?.enabled ?? false;

  const inner = (
    <div className={cn("space-y-4", noCard ? "p-4" : "")}>
      <p className="text-xs text-muted-foreground">
        Automatically scan workspaces for dependency updates, security advisories, and license issues.
        Configure and manage scans in detail from the{" "}
        <a href="/maintenance" className="text-primary underline underline-offset-2">
          Maintenance
        </a>{" "}
        page.
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading...
        </div>
      ) : (
        <div className="space-y-4">
          {/* Enable/disable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable Autopilot</p>
              <p className="text-xs text-muted-foreground">
                {firstPolicy
                  ? isEnabled
                    ? "Autopilot is active — scans run on schedule"
                    : "Autopilot is paused"
                  : "No policy configured yet"}
              </p>
            </div>
            <Switch
              checked={isEnabled}
              onCheckedChange={(checked) => {
                if (firstPolicy) {
                  togglePolicy.mutate({ id: firstPolicy.id, enabled: checked });
                } else if (checked) {
                  createPolicy.mutate();
                }
              }}
              disabled={togglePolicy.isPending || createPolicy.isPending}
            />
          </div>

          {/* Schedule selector */}
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium w-32 shrink-0">Default Schedule</label>
            <Select
              value={firstPolicy?.schedule ?? schedule}
              onValueChange={(val) => {
                setSchedule(val);
                if (firstPolicy) {
                  updatePolicy.mutate({ id: firstPolicy.id, schedule: val, severityThreshold: firstPolicy.severityThreshold });
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="Select schedule" />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value} className="text-xs">
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Severity threshold selector */}
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium w-32 shrink-0">Severity Threshold</label>
            <Select
              value={firstPolicy?.severityThreshold ?? severity}
              onValueChange={(val) => {
                setSeverity(val);
                if (firstPolicy) {
                  updatePolicy.mutate({ id: firstPolicy.id, schedule: firstPolicy.schedule, severityThreshold: val });
                }
              }}
            >
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="Select threshold" />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(togglePolicy.isError || createPolicy.isError || updatePolicy.isError) && (
            <p className="text-xs text-destructive">
              {((togglePolicy.error ?? createPolicy.error ?? updatePolicy.error) as Error).message}
            </p>
          )}
        </div>
      )}
    </div>
  );

  if (noCard) return inner;

  // Legacy standalone card render (backward-compat for any direct usage)
  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="px-4 py-3 border-b border-border">
        <p className="text-base font-semibold flex items-center gap-2">
          {isEnabled ? (
            <ShieldCheck className="h-4 w-4 text-green-500" />
          ) : (
            <Shield className="h-4 w-4 text-muted-foreground" />
          )}
          Maintenance Autopilot
        </p>
      </div>
      {inner}
    </div>
  );
}

interface MemoryPreferencesProps {
  /** When true, renders content only without a Card wrapper. Use inside SettingsSection. */
  noCard?: boolean;
}

function MemoryPreferences({ noCard = false }: MemoryPreferencesProps) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const savePreference = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "global",
          type: "preference",
          key,
          content: value,
          confidence: 1.0,
        }),
      });
      if (!res.ok) throw new Error("Failed to save preference");
      return res.json();
    },
    onSuccess: (_data, { key }) => {
      setSaved((prev) => ({ ...prev, [key]: true }));
      void qc.invalidateQueries({ queryKey: ["/api/memories"] });
      setTimeout(() => setSaved((prev) => ({ ...prev, [key]: false })), 2000);
    },
  });

  const inner = (
    <div className={cn("space-y-3", noCard ? "p-4" : "")}>
      <p className="text-xs text-muted-foreground">
        These preferences are stored as global memories and injected into every pipeline stage, helping the AI make consistent decisions aligned with your preferences.
      </p>
      {PREFERENCE_ROWS.map(({ key, label, placeholder }) => (
        <div key={key} className="flex items-center gap-3">
          <label className="text-xs font-medium w-44 shrink-0">{label}</label>
          <Input
            className="h-8 text-xs flex-1"
            placeholder={placeholder}
            value={values[key] ?? ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
          />
          <Button
            size="sm"
            className="h-8 text-xs shrink-0"
            disabled={!values[key]?.trim() || savePreference.isPending}
            onClick={() => {
              const value = values[key]?.trim();
              if (value) savePreference.mutate({ key, value });
            }}
          >
            {saved[key] ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            ) : savePreference.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <><Save className="h-3 w-3 mr-1" /> Save</>
            )}
          </Button>
        </div>
      ))}
    </div>
  );

  if (noCard) return inner;

  // Legacy standalone card render
  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="px-4 py-3 border-b border-border">
        <p className="text-base font-semibold flex items-center gap-2">
          <Brain className="h-4 w-4" /> Project Memory Preferences
        </p>
      </div>
      {inner}
    </div>
  );
}

export default function Settings() {
  const { data: models, isLoading: modelsLoading } = useModels();
  const { data: gatewayStatus } = useGatewayStatus();
  const { data: discovered, isLoading: discovering, refetch: rediscover } = useDiscoverProviderModels();
  const updateModel = useUpdateModel();
  const deleteModel = useDeleteModel();
  const importModel = useImportModel();
  const probeEndpoint = useProbeEndpoint();
  const qc = useQueryClient();

  const [probeUrl, setProbeUrl] = useState("");
  const [probeType, setProbeType] = useState<"vllm" | "ollama">("ollama");
  const [probeResults, setProbeResults] = useState<unknown[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [mcpForm, setMcpForm] = useState({ name: "", transport: "stdio", command: "", url: "", autoConnect: false });
  const [mcpError, setMcpError] = useState<string | null>(null);

  // Per-provider test state: key → result or null (null = idle/loading)
  const [testResults, setTestResults] = useState<Partial<Record<CloudProvider, ProviderTestResult | null>>>({});

  // Per-provider API key input state
  const [keyInputs, setKeyInputs] = useState<Partial<Record<CloudProvider, string>>>({});
  const [showKey, setShowKey] = useState<Partial<Record<CloudProvider, boolean>>>({});

  // Load provider key metadata from DB
  const { data: providerStatuses, isLoading: providerStatusesLoading, refetch: refetchProviderStatuses } = useQuery<ProviderStatus[]>({
    queryKey: ["/api/settings/providers"],
    queryFn: async () => {
      return apiRequest("GET", "/api/settings/providers").catch(() => [] as ProviderStatus[]);
    },
  });

  const testProvider = useMutation({
    mutationFn: async (provider: CloudProvider): Promise<{ provider: CloudProvider } & ProviderTestResult> => {
      const data = await apiRequest("POST", `/api/gateway/test/${provider}`) as ProviderTestResult;
      return { provider, ...data };
    },
    onMutate: (provider: CloudProvider) => {
      setTestResults((prev) => ({ ...prev, [provider]: null }));
    },
    onSuccess: (data) => {
      setTestResults((prev) => ({
        ...prev,
        [data.provider]: { ok: data.ok, latencyMs: data.latencyMs, error: data.error },
      }));
    },
    onError: (_err, provider) => {
      setTestResults((prev) => ({
        ...prev,
        [provider]: { ok: false, error: "Request failed" },
      }));
    },
  });

  const saveKey = useMutation({
    mutationFn: async ({ provider, apiKey }: { provider: CloudProvider; apiKey: string }) => {
      return apiRequest("POST", `/api/settings/providers/${provider}/key`, { key: apiKey });
    },
    onSuccess: (_data, { provider }) => {
      setKeyInputs((prev) => ({ ...prev, [provider]: "" }));
      void refetchProviderStatuses();
      void qc.invalidateQueries({ queryKey: ["/api/gateway/status"] });
    },
  });

  const removeKey = useMutation({
    mutationFn: async (provider: CloudProvider) => {
      return apiRequest("DELETE", `/api/settings/providers/${provider}/key`);
    },
    onSuccess: () => {
      void refetchProviderStatuses();
      void qc.invalidateQueries({ queryKey: ["/api/gateway/status"] });
    },
  });


  // MCP Servers
  const { data: mcpServers, refetch: refetchMcpServers } = useQuery({
    queryKey: ["/api/mcp/servers"],
    queryFn: async () => {
      return apiRequest("GET", "/api/mcp/servers").catch(() => [] as Array<Record<string, unknown>>);
    },
  });

  const { data: toolsStatus } = useQuery({
    queryKey: ["/api/tools/status"],
    queryFn: async () => {
      return apiRequest("GET", "/api/tools/status").catch(() => ({}) as Record<string, { configured: boolean; keySource: string; premium?: boolean }>);
    },
  });

  const connectMcpServer = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("POST", `/api/mcp/servers/${id}/connect`);
    },
    onSuccess: () => void refetchMcpServers(),
  });

  const disconnectMcpServer = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("POST", `/api/mcp/servers/${id}/disconnect`);
    },
    onSuccess: () => void refetchMcpServers(),
  });

  const deleteMcpServer = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/mcp/servers/${id}`);
    },
    onSuccess: () => void refetchMcpServers(),
  });

  const addMcpServer = useMutation({
    mutationFn: async (data: typeof mcpForm) => {
      return apiRequest("POST", "/api/mcp/servers", {
        name: data.name,
        transport: data.transport,
        command: data.transport === "stdio" ? data.command || undefined : undefined,
        url: data.transport !== "stdio" ? data.url || undefined : undefined,
        autoConnect: data.autoConnect,
        enabled: true,
      });
    },
    onSuccess: () => {
      setMcpForm({ name: "", transport: "stdio", command: "", url: "", autoConnect: false });
      setMcpError(null);
      void refetchMcpServers();
    },
    onError: (err: Error) => setMcpError(err.message),
  });


  const modelList: Array<Record<string, unknown>> = Array.isArray(models) ? models as Array<Record<string, unknown>> : [];
  const registeredSlugs = new Set(modelList.map((m) => m.slug as string));

  // Manual model entry form state
  const createModel = useCreateModel();
  const [manualName, setManualName] = useState('');
  const [manualProvider, setManualProvider] = useState<string>('ollama');
  const [manualSlug, setManualSlug] = useState('');
  const [manualEndpoint, setManualEndpoint] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const handleAddManual = () => {
    setManualError(null);
    if (!manualName.trim() || !manualSlug.trim()) {
      setManualError('Name and Model ID/slug are required');
      return;
    }
    if (manualEndpoint && !manualEndpoint.startsWith("http://") && !manualEndpoint.startsWith("https://")) {
      setManualError("Endpoint must start with http:// or https://");
      return;
    }
    const slug = manualSlug.trim().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    if (registeredSlugs.has(slug)) {
      setManualError('A model with this slug is already registered');
      return;
    }
    createModel.mutate(
      {
        name: manualName.trim(),
        provider: manualProvider,
        slug,
        endpoint: manualEndpoint.trim() || undefined,
        contextLimit: 4096,
        capabilities: ['general'],
        isActive: true,
      },
      {
        onSuccess: () => {
          setManualName('');
          setManualSlug('');
          setManualEndpoint('');
          setManualError(null);
        },
        onError: (err) => setManualError(err.message),
      },
    );
  };

  const handleProbe = () => {
    if (!probeUrl.trim()) return;
    setProbeError(null);
    setProbeResults(null);
    probeEndpoint.mutate(
      { endpoint: probeUrl.trim(), providerType: probeType },
      {
        onSuccess: (data: Record<string, unknown>) => setProbeResults((data.models as unknown[]) ?? []),
        onError: (err: Error) => setProbeError(err.message),
      },
    );
  };

  const handleImport = (model: Record<string, unknown>, provider: string, endpoint: string | null) => {
    const slug = (model.id as string).replace(/[^a-z0-9\-]/gi, "-").toLowerCase();
    if (registeredSlugs.has(slug)) return;
    importModel.mutate({
      name: (model.name as string) ?? (model.id as string),
      slug,
      provider,
      endpoint,
      contextLimit: (model.contextLength as number) ?? 4096,
      capabilities: ["general"],
      isActive: true,
    });
  };

  const handleRediscover = () => {
    void rediscover();
  };

  const discoveredVllm = (discovered as Record<string, { models: unknown[] }>)?.vllm?.models ?? [];
  const discoveredOllama = (discovered as Record<string, { models: unknown[] }>)?.ollama?.models ?? [];

  const getProviderStatus = (key: CloudProvider): ProviderStatus | undefined =>
    providerStatuses?.find((s) => s.provider === key);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-16 border-b border-border flex items-center px-6 bg-card shrink-0">
        <SettingsIcon className="h-5 w-5 mr-3 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Settings</h1>
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-4xl mx-auto p-6 space-y-3">

          {/* ── 1. Gateway Status ──────────────────────────── */}
          <SettingsSection
            title="Gateway Status"
            icon={<Server className="h-4 w-4" />}
            shortDescription="Live connection status for all configured model providers."
            longDescription="Shows real-time connectivity for each configured provider. Green = reachable and authenticated. Yellow = key configured but not tested. Red = unreachable or auth failed. Refresh to re-check."
            defaultOpen={true}
          >
            <div className="p-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-3 p-3 rounded-lg border border-border">
                  {gatewayStatus?.vllm ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <XCircle className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div>
                    <div className="text-sm font-medium">vLLM</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {(gatewayStatus as Record<string, unknown>)?.vllmEndpoint as string ?? "Not configured"}
                    </div>
                    {!(gatewayStatus as Record<string, unknown>)?.vllmEndpoint && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Set via <code className="font-mono">VLLM_ENDPOINT</code> environment variable
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-lg border border-border">
                  {gatewayStatus?.ollama ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <XCircle className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div>
                    <div className="text-sm font-medium">Ollama</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {(gatewayStatus as Record<string, unknown>)?.ollamaEndpoint as string ?? "Not configured"}
                    </div>
                    {!(gatewayStatus as Record<string, unknown>)?.ollamaEndpoint && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Set via <code className="font-mono">OLLAMA_ENDPOINT</code> environment variable
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* ── 2. Cloud Providers ─────────────────────────── */}
          <SettingsSection
            title="Cloud Providers"
            icon={<Cloud className="h-4 w-4" />}
            shortDescription="API keys for Claude (Anthropic), Gemini (Google), and Grok (xAI)."
            longDescription="API keys are encrypted (AES-256) before storage. Keys from environment variables (ANTHROPIC_API_KEY, GOOGLE_API_KEY, XAI_API_KEY) always take precedence and cannot be edited from the UI. Delete a DB key to fall back to env var or disable the provider."
            defaultOpen={true}
          >
            <div className="p-4 space-y-3">
              {CLOUD_PROVIDERS.map(({ key, name, envVar }) => {
                const isConfigured: boolean = !!(gatewayStatus as Record<string, unknown>)?.[key];
                const testResult = testResults[key];
                const isTesting = testResult === null && testProvider.isPending && testProvider.variables === key;
                const provStatus = getProviderStatus(key);
                const source = provStatus?.source ?? (isConfigured ? "env" : "none");
                const keyValue = keyInputs[key] ?? "";
                const isVisible = showKey[key] ?? false;
                const isSaving = saveKey.isPending && (saveKey.variables as { provider: CloudProvider })?.provider === key;
                const isRemoving = removeKey.isPending && removeKey.variables === key;

                return (
                  <div
                    key={key}
                    className="flex flex-col gap-3 p-4 rounded-lg border border-border"
                  >
                    {/* Top row: icon + name + badges + test button */}
                    <div className="flex items-start gap-4">
                      <div className="mt-0.5 shrink-0">
                        {isConfigured ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                        ) : (
                          <XCircle className="h-5 w-5 text-muted-foreground" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium">{name}</span>
                          {isConfigured ? (
                            <Badge className="text-[10px] bg-emerald-500/15 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15">
                              Connected
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px]">
                              Not configured
                            </Badge>
                          )}
                          {source === "db" && (
                            <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-500/30">
                              Saved in DB
                            </Badge>
                          )}
                          {!providerStatusesLoading && source === "env" && (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              From env var
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs text-muted-foreground">Env var:</span>
                          <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">
                            {envVar}
                          </code>
                        </div>

                        {/* Test result feedback */}
                        {testResult !== undefined && testResult !== null && (
                          <div
                            className={cn(
                              "text-xs mt-1.5 px-2 py-1 rounded",
                              testResult.ok
                                ? "text-emerald-600 bg-emerald-500/10"
                                : "text-destructive bg-destructive/10",
                            )}
                          >
                            {testResult.ok
                              ? `Connected — ${testResult.latencyMs}ms`
                              : `Error: ${testResult.error}`}
                          </div>
                        )}
                      </div>

                      {/* Test button */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs shrink-0"
                        disabled={!isConfigured || isTesting}
                        onClick={() => testProvider.mutate(key)}
                      >
                        {isTesting ? (
                          <>
                            <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                            Testing
                          </>
                        ) : (
                          "Test"
                        )}
                      </Button>
                    </div>

                    {/* API key input row */}
                    <div className="flex items-center gap-2 pl-9">
                      <div className="relative flex-1">
                        <Input
                          type={isVisible ? "text" : "password"}
                          className="h-8 text-xs pr-8 font-mono"
                          placeholder="Paste API key to save…"
                          value={keyValue}
                          onChange={(e) =>
                            setKeyInputs((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          onClick={() =>
                            setShowKey((prev) => ({ ...prev, [key]: !prev[key] }))
                          }
                        >
                          {isVisible ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                      <Button
                        size="sm"
                        className="h-8 text-xs shrink-0"
                        disabled={!keyValue.trim() || isSaving}
                        onClick={() =>
                          saveKey.mutate({ provider: key, apiKey: keyValue.trim() })
                        }
                      >
                        {isSaving ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <Save className="h-3 w-3 mr-1" /> Save
                          </>
                        )}
                      </Button>
                      {source === "db" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs text-destructive hover:text-destructive shrink-0"
                          disabled={isRemoving}
                          onClick={() => removeKey.mutate(key)}
                        >
                          {isRemoving ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <Trash2 className="h-3 w-3 mr-1" /> Remove
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                    {(saveKey.isError && (saveKey.variables as { provider: CloudProvider })?.provider === key) && (
                      <p className="text-xs text-destructive mt-1">{(saveKey.error as Error)?.message}</p>
                    )}
                    {(removeKey.isError && removeKey.variables === key) && (
                      <p className="text-xs text-destructive mt-1">{(removeKey.error as Error)?.message}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </SettingsSection>

          {/* ── 3. Discover Models ─────────────────────────── */}
          <SettingsSection
            title="Discover Models"
            icon={<Search className="h-4 w-4" />}
            shortDescription="Auto-detect available models from connected providers."
            longDescription="Queries the provider's model list endpoint and imports available models into the registry. Only works when the provider's API key is configured and valid."
            defaultOpen={false}
          >
            <div className="p-4 space-y-4">
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRediscover}
                  disabled={discovering}
                  className="text-xs h-8"
                >
                  {discovering ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-1" />
                  )}
                  Refresh
                </Button>
              </div>

              {/* vLLM discovered */}
              {(discovered as Record<string, { available: boolean; error?: string; models: unknown[] }>)?.vllm?.available && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2">
                    <Server className="h-3 w-3" /> vLLM Models
                    {(discovered as Record<string, { error?: string }>).vllm.error && (
                      <span className="text-destructive">— {(discovered as Record<string, { error: string }>).vllm.error}</span>
                    )}
                  </div>
                  {discoveredVllm.length > 0 ? (
                    <div className="space-y-2">
                      {(discoveredVllm as Array<Record<string, unknown>>).map((m) => {
                        const slug = (m.id as string).replace(/[^a-z0-9\-]/gi, "-").toLowerCase();
                        const alreadyRegistered = registeredSlugs.has(slug);
                        return (
                          <div key={m.id as string} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                            <Cpu className="h-4 w-4 text-blue-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{m.name as string}</div>
                              <div className="text-xs text-muted-foreground">
                                {m.contextLength ? `${((m.contextLength as number) / 1024).toFixed(0)}k ctx` : ""}
                                {m.owned_by ? ` · ${m.owned_by as string}` : ""}
                              </div>
                            </div>
                            <Badge variant="outline" className="text-[10px] shrink-0">vllm</Badge>
                            {alreadyRegistered ? (
                              <Badge variant="secondary" className="text-[10px]">Registered</Badge>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => handleImport(m, "vllm", (gatewayStatus as Record<string, unknown>)?.vllmEndpoint as string ?? null)}
                                disabled={importModel.isPending}
                              >
                                <Plus className="h-3 w-3 mr-1" /> Add
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground p-3 border border-dashed rounded-lg">
                      No models found on vLLM endpoint
                    </div>
                  )}
                </div>
              )}

              {/* Ollama discovered */}
              {(discovered as Record<string, { available: boolean; error?: string; models: unknown[] }>)?.ollama?.available && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2">
                    <Server className="h-3 w-3" /> Ollama Models
                    {(discovered as Record<string, { error?: string }>).ollama?.error && (
                      <span className="text-destructive">— {(discovered as Record<string, { error: string }>).ollama.error}</span>
                    )}
                  </div>
                  {discoveredOllama.length > 0 ? (
                    <div className="space-y-2">
                      {(discoveredOllama as Array<Record<string, unknown>>).map((m) => {
                        const slug = (m.id as string).replace(/[^a-z0-9\-]/gi, "-").toLowerCase();
                        const alreadyRegistered = registeredSlugs.has(slug);
                        return (
                          <div key={m.id as string} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                            <Cpu className="h-4 w-4 text-green-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{m.name as string}</div>
                              <div className="text-xs text-muted-foreground">
                                {m.parameterSize as string ?? ""}
                                {m.quantization ? ` · ${m.quantization as string}` : ""}
                                {m.family ? ` · ${m.family as string}` : ""}
                              </div>
                            </div>
                            <Badge variant="outline" className="text-[10px] shrink-0">ollama</Badge>
                            {alreadyRegistered ? (
                              <Badge variant="secondary" className="text-[10px]">Registered</Badge>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => handleImport(m, "ollama", (gatewayStatus as Record<string, unknown>)?.ollamaEndpoint as string ?? null)}
                                disabled={importModel.isPending}
                              >
                                <Plus className="h-3 w-3 mr-1" /> Add
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground p-3 border border-dashed rounded-lg">
                      No models found on Ollama endpoint
                    </div>
                  )}
                </div>
              )}

              {/* Neither connected */}
              {!(discovered as Record<string, { available: boolean }>)?.vllm?.available &&
               !(discovered as Record<string, { available: boolean }>)?.ollama?.available &&
               !discovering && (
                <div className="text-sm text-muted-foreground p-4 border border-dashed rounded-lg text-center">
                  No provider endpoints configured. Set <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">VLLM_ENDPOINT</code> or{" "}
                  <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">OLLAMA_ENDPOINT</code> environment variables, or use the probe tool below.
                </div>
              )}
            </div>
          </SettingsSection>

          {/* ── 4. Probe Endpoint ──────────────────────────── */}
          <SettingsSection
            title="Probe Endpoint"
            icon={<Globe className="h-4 w-4" />}
            shortDescription="Test a custom vLLM or Ollama endpoint before registering."
            longDescription="Send a test request to any HTTP endpoint to verify it's running a compatible LLM API (OpenAI-compatible, vLLM, or Ollama format). Use this before adding a custom local model."
            defaultOpen={false}
          >
            <div className="p-4 space-y-4">
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Endpoint URL</label>
                  <Input
                    className="h-9 text-sm"
                    placeholder="http://localhost:11434"
                    value={probeUrl}
                    onChange={(e) => setProbeUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleProbe()}
                  />
                </div>
                <div className="w-32">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Provider</label>
                  <Select value={probeType} onValueChange={(v) => setProbeType(v as "vllm" | "ollama")}>
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ollama">Ollama</SelectItem>
                      <SelectItem value="vllm">vLLM</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={handleProbe} disabled={!probeUrl.trim() || probeEndpoint.isPending} className="h-9">
                  {probeEndpoint.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {probeError && (
                <div className="text-sm text-destructive p-3 rounded-lg border border-destructive/30 bg-destructive/5">
                  Connection failed: {probeError}
                </div>
              )}

              {probeResults && probeResults.length === 0 && (
                <div className="text-sm text-muted-foreground p-3 border border-dashed rounded-lg">
                  Connected but no models found on this endpoint.
                </div>
              )}

              {probeResults && probeResults.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    Found {probeResults.length} model{probeResults.length !== 1 ? "s" : ""}:
                  </div>
                  {(probeResults as Array<Record<string, unknown>>).map((m) => {
                    const slug = (m.id as string).replace(/[^a-z0-9\-]/gi, "-").toLowerCase();
                    const alreadyRegistered = registeredSlugs.has(slug);
                    return (
                      <div key={m.id as string} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                        <Cpu className="h-4 w-4 text-violet-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{(m.name as string) ?? (m.id as string)}</div>
                          <div className="text-xs text-muted-foreground">
                            {m.parameterSize as string ?? ""}{m.quantization ? ` · ${m.quantization as string}` : ""}
                            {m.contextLength ? ` · ${((m.contextLength as number) / 1024).toFixed(0)}k ctx` : ""}
                          </div>
                        </div>
                        <Badge variant="outline" className="text-[10px]">{probeType}</Badge>
                        {alreadyRegistered ? (
                          <Badge variant="secondary" className="text-[10px]">Registered</Badge>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleImport(m, probeType, probeUrl.trim())}
                            disabled={importModel.isPending}
                          >
                            <Plus className="h-3 w-3 mr-1" /> Add
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </SettingsSection>

          {/* ── 5. Add Model ───────────────────────────────── */}
          <SettingsSection
            title="Add Model"
            icon={<Plus className="h-4 w-4" />}
            shortDescription="Manually register a model with a custom slug and endpoint."
            longDescription="Register any OpenAI-compatible, vLLM, or Ollama endpoint as a model. The slug must be unique and is used for pipeline stage assignment. Provider type determines which SDK is used."
            defaultOpen={false}
          >
            <div className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Add non-discoverable models such as private vLLM or Ollama deployments.
              </p>
              <div className="grid grid-cols-1 gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Model Name</label>
                    <Input
                      className="h-8 text-xs"
                      placeholder="My Custom Model"
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Provider</label>
                    <Select value={manualProvider} onValueChange={setManualProvider}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ollama">Ollama</SelectItem>
                        <SelectItem value="vllm">vLLM</SelectItem>
                        <SelectItem value="anthropic">Anthropic</SelectItem>
                        <SelectItem value="google">Google</SelectItem>
                        <SelectItem value="xai">xAI</SelectItem>
                        <SelectItem value="mock">Mock</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Model ID / Slug</label>
                  <Input
                    className="h-8 text-xs font-mono"
                    placeholder="my-custom-model"
                    value={manualSlug}
                    onChange={(e) => setManualSlug(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Endpoint URL (optional)</label>
                  <Input
                    className="h-8 text-xs"
                    placeholder="http://localhost:11434"
                    value={manualEndpoint}
                    onChange={(e) => setManualEndpoint(e.target.value)}
                  />
                </div>
                {manualError && (
                  <div className="text-xs text-destructive p-2 rounded border border-destructive/30 bg-destructive/5">
                    {manualError}
                  </div>
                )}
                <Button
                  size="sm"
                  className="h-8 text-xs w-full"
                  onClick={handleAddManual}
                  disabled={createModel.isPending}
                >
                  {createModel.isPending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3 mr-1" />
                  )}
                  Add Model
                </Button>
              </div>
            </div>
          </SettingsSection>

          {/* ── 6. Registered Models ───────────────────────── */}
          <SettingsSection
            title="Registered Models"
            icon={<Cpu className="h-4 w-4" />}
            shortDescription="All models available for pipeline stage assignment."
            longDescription="All models available for assignment to pipeline stages. Includes cloud models (Claude, Gemini, Grok), local models (vLLM, Ollama), and mock models for testing. Delete removes from the registry but does not affect running pipelines."
            defaultOpen={true}
          >
            <div className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="secondary" className="text-[10px]">
                  {modelList.length} registered
                </Badge>
              </div>
              {modelsLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading models...
                </div>
              ) : modelList.length === 0 ? (
                <div className="text-sm text-muted-foreground p-4 border border-dashed rounded-lg text-center">
                  No models registered. Discover from providers above or add manually.
                </div>
              ) : (
                <div className="space-y-3">
                  {modelList.map((model) => (
                    <div
                      key={model.id as string}
                      className={cn(
                        "flex items-center gap-4 p-4 rounded-lg border border-border transition-opacity",
                        !model.isActive && "opacity-50",
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{model.name as string}</span>
                          <Badge variant="outline" className="text-[10px]">{model.provider as string}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          <span className="font-mono">{model.slug as string}</span>
                          {!!model.contextLimit && (
                            <span>{((model.contextLimit as number) / 1024).toFixed(0)}k ctx</span>
                          )}
                          {!!model.endpoint && (
                            <span className="truncate max-w-[200px]">{model.endpoint as string}</span>
                          )}
                        </div>
                        {Array.isArray(model.capabilities) && model.capabilities.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {(model.capabilities as string[]).map((cap) => (
                              <Badge key={cap} variant="secondary" className="text-[10px] py-0">
                                {cap}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Active</span>
                          <Switch
                            checked={!!model.isActive}
                            onCheckedChange={(checked) =>
                              updateModel.mutate({ id: model.id as string, isActive: checked })
                            }
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            if (!window.confirm(`Delete model "${model.name}"? This cannot be undone.`)) return;
                            deleteModel.mutate(model.id as string);
                          }}
                          disabled={deleteModel.isPending && deleteModel.variables === model.id}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SettingsSection>

          {/* ── 7. Tools & MCP ─────────────────────────────── */}
          <SettingsSection
            title="Tools & MCP"
            icon={<Plug className="h-4 w-4" />}
            shortDescription="Connect external MCP servers and built-in tools."
            longDescription="Model Context Protocol servers extend agent capabilities with external tools (web search, file access, databases). Built-in tools (Tavily, etc.) require their own API keys. MCP servers must be running and reachable at the configured URL."
            defaultOpen={false}
          >
            <div className="p-4 space-y-4">
              {/* Built-in tools grid */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Built-in Tools</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { name: "web_search", label: "Web Search", desc: (toolsStatus as Record<string, { keySource: string; premium?: boolean }> | undefined)?.web_search?.premium ? "Tavily (premium)" : "DuckDuckGo (fallback)" },
                    { name: "url_reader", label: "URL Reader", desc: "Jina AI (free)" },
                    { name: "knowledge_search", label: "Knowledge Search", desc: "Internal storage" },
                    { name: "memory_search", label: "Memory Search", desc: "Internal storage" },
                  ].map((tool) => (
                    <div key={tool.name} className="flex items-start gap-2 p-3 rounded-lg border border-border bg-card">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="text-xs font-medium font-mono">{tool.name}</div>
                        <div className="text-xs text-muted-foreground">{tool.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Set <code className="font-mono bg-muted px-1 rounded">TAVILY_API_KEY</code> for premium web search results.
                </p>
              </div>

              {/* MCP Servers */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">MCP Servers</p>
                {mcpServers && (mcpServers as Array<Record<string, unknown>>).length > 0 ? (
                  <div className="space-y-2 mb-3">
                    {(mcpServers as Array<Record<string, unknown>>).map((server) => (
                      <div key={server.id as number} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                        <Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium">{server.name as string}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {server.transport as string}
                            {server.command ? ` · ${server.command as string}` : ""}
                            {server.url ? ` · ${server.url as string}` : ""}
                          </div>
                        </div>
                        <Badge
                          variant={server.connected ? "default" : "secondary"}
                          className="text-[10px] shrink-0"
                        >
                          {server.connected ? "Connected" : "Disconnected"}
                          {server.toolCount ? ` (${server.toolCount as number})` : ""}
                        </Badge>
                        {server.connected ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs shrink-0"
                            onClick={() => disconnectMcpServer.mutate(server.id as number)}
                            disabled={disconnectMcpServer.isPending}
                          >
                            Disconnect
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs shrink-0"
                            onClick={() => connectMcpServer.mutate(server.id as number)}
                            disabled={connectMcpServer.isPending}
                          >
                            <Link2 className="h-3 w-3 mr-1" />
                            Connect
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                          onClick={() => {
                            if (!window.confirm(`Remove MCP server "${server.name}"?`)) return;
                            deleteMcpServer.mutate(server.id as number);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground p-3 border border-dashed rounded-lg mb-3">
                    No MCP servers configured.
                  </div>
                )}

                {/* Add MCP Server Form */}
                <div className="space-y-2 p-3 border border-border rounded-lg bg-muted/10">
                  <p className="text-xs font-medium">Add MCP Server</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Name</label>
                      <Input
                        className="h-7 text-xs"
                        placeholder="my-mcp-server"
                        value={mcpForm.name}
                        onChange={(e) => setMcpForm((f) => ({ ...f, name: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Transport</label>
                      <Select
                        value={mcpForm.transport}
                        onValueChange={(v) => setMcpForm((f) => ({ ...f, transport: v }))}
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="stdio">stdio</SelectItem>
                          <SelectItem value="sse">SSE</SelectItem>
                          <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {mcpForm.transport === "stdio" ? (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Command</label>
                      <Input
                        className="h-7 text-xs font-mono"
                        placeholder="npx -y @modelcontextprotocol/server-filesystem /"
                        value={mcpForm.command}
                        onChange={(e) => setMcpForm((f) => ({ ...f, command: e.target.value }))}
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">URL</label>
                      <Input
                        className="h-7 text-xs font-mono"
                        placeholder="http://localhost:3001/mcp"
                        value={mcpForm.url}
                        onChange={(e) => setMcpForm((f) => ({ ...f, url: e.target.value }))}
                      />
                      {mcpForm.transport !== "stdio" && !mcpForm.url.trim() && (
                        <p className="text-xs text-destructive mt-1">URL is required for {mcpForm.transport} transport</p>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={mcpForm.autoConnect}
                      onCheckedChange={(v) => setMcpForm((f) => ({ ...f, autoConnect: v }))}
                    />
                    <span className="text-xs text-muted-foreground">Auto-connect on save</span>
                  </div>
                  {mcpError && (
                    <div className="text-xs text-destructive p-2 rounded border border-destructive/30 bg-destructive/5">
                      {mcpError}
                    </div>
                  )}
                  <Button
                    size="sm"
                    className="h-7 text-xs w-full"
                    onClick={() => addMcpServer.mutate(mcpForm)}
                    disabled={addMcpServer.isPending || !mcpForm.name.trim() || (mcpForm.transport !== "stdio" && !mcpForm.url.trim())}
                  >
                    {addMcpServer.isPending ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Plus className="h-3 w-3 mr-1" />
                    )}
                    Add Server
                  </Button>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* ── 8. ArgoCD ──────────────────────────────────── */}
          <SettingsSection
            title="ArgoCD"
            icon={<Server className="h-4 w-4" />}
            shortDescription="GitOps deployment integration via ArgoCD."
            longDescription="Connect to an ArgoCD instance to manage GitOps deployments directly from multiqlti pipelines. Requires ArgoCD server URL and an API token with application read/sync permissions."
            defaultOpen={false}
          >
            <ArgocdSettings noCard />
          </SettingsSection>

          {/* ── 9. Maintenance Autopilot ───────────────────── */}
          <SettingsSection
            title="Maintenance Autopilot"
            icon={<Shield className="h-4 w-4" />}
            shortDescription="Scheduled scanning for dependency updates and security advisories."
            longDescription="Runs automated scans on a cron schedule to detect outdated dependencies, CVEs, license issues, and config drift. Findings appear in the Maintenance page. Scans use the Development team's configured model."
            defaultOpen={false}
          >
            <MaintenanceSettings noCard />
          </SettingsSection>

          {/* ── 10. Memory Preferences ─────────────────────── */}
          <SettingsSection
            title="Memory Preferences"
            icon={<Brain className="h-4 w-4" />}
            shortDescription="Persistent AI preferences injected into pipeline stage prompts."
            longDescription="These preferences are injected into every pipeline stage's system prompt as context. Use them to encode your team's standards, preferred technologies, and coding style so agents consistently produce on-brand output."
            defaultOpen={false}
          >
            <MemoryPreferences noCard />
          </SettingsSection>

        </div>
      </ScrollArea>
    </div>
  );
}
