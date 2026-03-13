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
import { useQueryClient } from "@tanstack/react-query";

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
  const [probeResults, setProbeResults] = useState<any[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const modelList: any[] = Array.isArray(models) ? models : [];
  const registeredSlugs = new Set(modelList.map((m: any) => m.slug));

  const handleProbe = () => {
    if (!probeUrl.trim()) return;
    setProbeError(null);
    setProbeResults(null);
    probeEndpoint.mutate(
      { endpoint: probeUrl.trim(), providerType: probeType },
      {
        onSuccess: (data: any) => setProbeResults(data.models ?? []),
        onError: (err: any) => setProbeError(err.message),
      },
    );
  };

  const handleImport = (model: any, provider: string, endpoint: string | null) => {
    const slug = model.id.replace(/[^a-z0-9\-]/gi, "-").toLowerCase();
    if (registeredSlugs.has(slug)) return; // already registered
    importModel.mutate({
      name: model.name ?? model.id,
      slug,
      provider,
      endpoint,
      contextLimit: model.contextLength ?? 4096,
      capabilities: ["general"],
      isActive: true,
    });
  };

  const handleRediscover = () => {
    rediscover();
  };

  // Flatten discovered models from providers
  const discoveredVllm = discovered?.vllm?.models ?? [];
  const discoveredOllama = discovered?.ollama?.models ?? [];

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
                      {gatewayStatus?.vllmEndpoint ?? "Not configured"}
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
                      {gatewayStatus?.ollamaEndpoint ?? "Not configured"}
                    </div>
                  </div>
                </div>
              </div>
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
              {discovered?.vllm?.available && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2">
                    <Server className="h-3 w-3" /> vLLM Models
                    {discovered.vllm.error && (
                      <span className="text-destructive">— {discovered.vllm.error}</span>
                    )}
                  </div>
                  {discoveredVllm.length > 0 ? (
                    <div className="space-y-2">
                      {discoveredVllm.map((m: any) => {
                        const slug = m.id.replace(/[^a-z0-9\-]/gi, "-").toLowerCase();
                        const alreadyRegistered = registeredSlugs.has(slug);
                        return (
                          <div key={m.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                            <Cpu className="h-4 w-4 text-blue-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{m.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {m.contextLength ? `${(m.contextLength / 1024).toFixed(0)}k ctx` : ""}
                                {m.owned_by ? ` · ${m.owned_by}` : ""}
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
                                onClick={() => handleImport(m, "vllm", gatewayStatus?.vllmEndpoint ?? null)}
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
              {discovered?.ollama?.available && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2">
                    <Server className="h-3 w-3" /> Ollama Models
                    {discovered.ollama.error && (
                      <span className="text-destructive">— {discovered.ollama.error}</span>
                    )}
                  </div>
                  {discoveredOllama.length > 0 ? (
                    <div className="space-y-2">
                      {discoveredOllama.map((m: any) => {
                        const slug = m.id.replace(/[^a-z0-9\-]/gi, "-").toLowerCase();
                        const alreadyRegistered = registeredSlugs.has(slug);
                        return (
                          <div key={m.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                            <Cpu className="h-4 w-4 text-green-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{m.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {m.parameterSize ?? ""}
                                {m.quantization ? ` · ${m.quantization}` : ""}
                                {m.family ? ` · ${m.family}` : ""}
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
                                onClick={() => handleImport(m, "ollama", gatewayStatus?.ollamaEndpoint ?? null)}
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
              {!discovered?.vllm?.available && !discovered?.ollama?.available && !discovering && (
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
                  {probeResults.map((m: any) => {
                    const slug = m.id.replace(/[^a-z0-9\-]/gi, "-").toLowerCase();
                    const alreadyRegistered = registeredSlugs.has(slug);
                    return (
                      <div key={m.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card">
                        <Cpu className="h-4 w-4 text-violet-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{m.name ?? m.id}</div>
                          <div className="text-xs text-muted-foreground">
                            {m.parameterSize ?? ""}{m.quantization ? ` · ${m.quantization}` : ""}
                            {m.contextLength ? ` · ${(m.contextLength / 1024).toFixed(0)}k ctx` : ""}
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
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading models…
                </div>
              ) : modelList.length === 0 ? (
                <div className="text-sm text-muted-foreground p-4 border border-dashed rounded-lg text-center">
                  No models registered. Discover from providers above or add manually.
                </div>
              ) : (
                <div className="space-y-3">
                  {modelList.map((model: any) => (
                    <div
                      key={model.id}
                      className={cn(
                        "flex items-center gap-4 p-4 rounded-lg border border-border transition-opacity",
                        !model.isActive && "opacity-50",
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{model.name}</span>
                          <Badge variant="outline" className="text-[10px]">{model.provider}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          <span className="font-mono">{model.slug}</span>
                          {model.contextLimit && (
                            <span>{(model.contextLimit / 1024).toFixed(0)}k ctx</span>
                          )}
                          {model.endpoint && (
                            <span className="truncate max-w-[200px]">{model.endpoint}</span>
                          )}
                        </div>
                        {Array.isArray(model.capabilities) && model.capabilities.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {model.capabilities.map((cap: string) => (
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
                              updateModel.mutate({ id: model.id, isActive: checked })
                            }
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => deleteModel.mutate(model.id)}
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
