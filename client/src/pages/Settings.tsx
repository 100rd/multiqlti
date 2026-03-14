import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "lucide-react";
import {
  useModels,
  useUpdateModel,
  useDeleteModel,
  useImportModel,
  useGatewayStatus,
  useDiscoverProviderModels,
  useProbeEndpoint,
} from "@/hooks/use-pipeline";
import { cn } from "@/lib/utils";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";

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

  // Per-provider test state: key → result or null (null = idle/loading)
  const [testResults, setTestResults] = useState<Partial<Record<CloudProvider, ProviderTestResult | null>>>({});

  // Per-provider API key input state
  const [keyInputs, setKeyInputs] = useState<Partial<Record<CloudProvider, string>>>({});
  const [showKey, setShowKey] = useState<Partial<Record<CloudProvider, boolean>>>({});

  // Load provider key metadata from DB
  const { data: providerStatuses, refetch: refetchProviderStatuses } = useQuery<ProviderStatus[]>({
    queryKey: ["/api/settings/providers"],
    queryFn: async () => {
      const res = await fetch("/api/settings/providers");
      if (!res.ok) return [];
      return res.json() as Promise<ProviderStatus[]>;
    },
  });

  const testProvider = useMutation({
    mutationFn: async (provider: CloudProvider): Promise<{ provider: CloudProvider } & ProviderTestResult> => {
      const res = await fetch(`/api/gateway/test/${provider}`, { method: "POST" });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        return { provider, ok: false, error: text || res.statusText };
      }
      const data = await res.json() as ProviderTestResult;
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
      const res = await fetch(`/api/settings/providers/${provider}/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error ?? "Save failed");
      }
      return res.json();
    },
    onSuccess: (_data, { provider }) => {
      setKeyInputs((prev) => ({ ...prev, [provider]: "" }));
      void refetchProviderStatuses();
      void qc.invalidateQueries({ queryKey: ["/api/gateway/status"] });
    },
  });

  const removeKey = useMutation({
    mutationFn: async (provider: CloudProvider) => {
      const res = await fetch(`/api/settings/providers/${provider}/key`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error ?? "Remove failed");
      }
      return res.json();
    },
    onSuccess: () => {
      void refetchProviderStatuses();
      void qc.invalidateQueries({ queryKey: ["/api/gateway/status"] });
    },
  });

  const modelList: Array<Record<string, unknown>> = Array.isArray(models) ? models as Array<Record<string, unknown>> : [];
  const registeredSlugs = new Set(modelList.map((m) => m.slug as string));

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
        <div className="max-w-4xl mx-auto p-6 space-y-6">
          {/* ── Gateway Status ─────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Globe className="h-4 w-4" /> Gateway Status
              </CardTitle>
            </CardHeader>
            <CardContent>
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
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── Cloud Providers ────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Cloud className="h-4 w-4" /> Cloud Providers
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
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
                          {source === "env" && (
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
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* ── Discover from Connected Providers ──────── */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Search className="h-4 w-4" /> Discover Models from Providers
                </CardTitle>
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
            </CardHeader>
            <CardContent className="space-y-4">
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
            </CardContent>
          </Card>

          {/* ── Probe Custom Endpoint ──────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Plug className="h-4 w-4" /> Probe Custom Endpoint
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
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
            </CardContent>
          </Card>

          {/* ── Registered Models ──────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Cpu className="h-4 w-4" /> Registered Models
                <Badge variant="secondary" className="ml-1 text-[10px]">
                  {modelList.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
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
                          onClick={() => deleteModel.mutate(model.id as string)}
                          disabled={deleteModel.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
