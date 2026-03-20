import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Monitor,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Plus,
  Cpu,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/hooks/use-pipeline";
import { SettingsSection } from "./SettingsSection";

interface LmStudioModel {
  id: string;
  name: string;
  provider: "lmstudio";
  owned_by?: string;
}

interface LmStudioStatus {
  connected: boolean;
  endpoint: string;
  models: LmStudioModel[];
  error?: string;
}

interface ImportResult {
  imported: Array<{ slug: string; name: string }>;
  errors: Array<{ id: string; error: string }>;
}

export function LmStudioConnect() {
  const queryClient = useQueryClient();
  const [endpoint, setEndpoint] = useState("http://localhost:1234");
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [showEndpointInput, setShowEndpointInput] = useState(false);

  // Fetch LM Studio status (only when explicitly triggered)
  const {
    data: status,
    isLoading: isChecking,
    refetch: checkStatus,
    isFetched,
  } = useQuery<LmStudioStatus>({
    queryKey: ["/api/lmstudio/status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/lmstudio/status");
      return res.json();
    },
    enabled: false, // Only fetch on demand
    retry: false,
  });

  // Change endpoint mutation
  const changeEndpoint = useMutation({
    mutationFn: async (newEndpoint: string) => {
      const res = await apiRequest("PUT", "/api/lmstudio/endpoint", {
        endpoint: newEndpoint,
      });
      if (!res.ok) throw new Error("Failed to update endpoint");
      return res.json();
    },
    onSuccess: () => {
      setShowEndpointInput(false);
      checkStatus();
    },
  });

  // Import models mutation
  const importModels = useMutation<ImportResult>({
    mutationFn: async () => {
      const models = (status?.models ?? [])
        .filter((m) => selectedModels.has(m.id))
        .map((m) => ({ id: m.id, name: m.name }));
      const res = await apiRequest("POST", "/api/lmstudio/import", {
        models,
        endpoint: status?.endpoint,
      });
      if (!res.ok) throw new Error("Failed to import models");
      return res.json();
    },
    onSuccess: (data) => {
      // Clear selection for successfully imported models
      const importedIds = new Set(data.imported.map((m) => m.slug));
      setSelectedModels((prev) => {
        const next = new Set(prev);
        for (const id of prev) {
          const slug = id
            .replace(/[^a-z0-9-]/gi, "-")
            .toLowerCase()
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "");
          if (importedIds.has(slug)) next.delete(id);
        }
        return next;
      });
      // Refresh models list and gateway status
      queryClient.invalidateQueries({ queryKey: ["/api/models"] });
      queryClient.invalidateQueries({ queryKey: ["/api/gateway/status"] });
      checkStatus();
    },
  });

  const handleConnect = () => {
    checkStatus();
  };

  const handleToggleModel = (modelId: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedModels.size === (status?.models?.length ?? 0)) {
      setSelectedModels(new Set());
    } else {
      setSelectedModels(new Set((status?.models ?? []).map((m) => m.id)));
    }
  };

  const isConnected = status?.connected === true;
  const hasModels = (status?.models?.length ?? 0) > 0;

  return (
    <SettingsSection
      title="LM Studio"
      icon={<Monitor className="h-4 w-4" />}
      shortDescription="One-click connection to local models running in LM Studio."
      longDescription="Connect to LM Studio running on your machine to use local LLMs. LM Studio provides an OpenAI-compatible API at localhost:1234 by default. Click Connect to detect running models, then import them into the platform."
    >
      <div className="p-4 space-y-4">
        {/* Connection row */}
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          {isFetched && !isChecking && (
            isConnected ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
            ) : (
              <XCircle className="h-5 w-5 text-muted-foreground shrink-0" />
            )
          )}

          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">
              {isChecking
                ? "Connecting…"
                : isConnected
                  ? "Connected"
                  : isFetched
                    ? "Not Connected"
                    : "LM Studio Local Server"}
            </div>
            <div className="text-xs text-muted-foreground font-mono truncate">
              {status?.endpoint ?? endpoint}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setShowEndpointInput(!showEndpointInput)}
            >
              Edit URL
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={isChecking}
              onClick={handleConnect}
            >
              {isChecking ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  Checking
                </>
              ) : isFetched && isConnected ? (
                <>
                  <RefreshCw className="h-3 w-3 mr-1.5" />
                  Refresh
                </>
              ) : (
                "Connect"
              )}
            </Button>
          </div>
        </div>

        {/* Custom endpoint input */}
        {showEndpointInput && (
          <div className="flex items-center gap-2 pl-8">
            <Input
              type="url"
              className="h-8 text-xs font-mono flex-1"
              placeholder="http://localhost:1234"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
            <Button
              size="sm"
              className="h-8 text-xs"
              disabled={!endpoint.trim() || changeEndpoint.isPending}
              onClick={() => changeEndpoint.mutate(endpoint.trim())}
            >
              {changeEndpoint.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Apply"
              )}
            </Button>
          </div>
        )}

        {/* Error message */}
        {isFetched && !isChecking && status?.error && (
          <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
            {status.error}
          </div>
        )}

        {/* Model list */}
        {isConnected && hasModels && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                <Cpu className="h-3 w-3" />
                Loaded Models ({status!.models.length})
              </div>
              <button
                type="button"
                className="text-[10px] text-primary hover:underline"
                onClick={handleSelectAll}
              >
                {selectedModels.size === status!.models.length
                  ? "Deselect All"
                  : "Select All"}
              </button>
            </div>

            <div className="space-y-1.5">
              {status!.models.map((model) => (
                <label
                  key={model.id}
                  className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer"
                >
                  <Checkbox
                    checked={selectedModels.has(model.id)}
                    onCheckedChange={() => handleToggleModel(model.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium font-mono truncate">
                      {model.name}
                    </div>
                    {model.owned_by && (
                      <div className="text-[10px] text-muted-foreground">
                        {model.owned_by}
                      </div>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className="text-[10px] shrink-0"
                  >
                    lmstudio
                  </Badge>
                </label>
              ))}
            </div>

            {/* Import button */}
            <div className="flex items-center justify-between pt-1">
              <div className="text-[11px] text-muted-foreground">
                {selectedModels.size > 0
                  ? `${selectedModels.size} model${selectedModels.size > 1 ? "s" : ""} selected`
                  : "Select models to import"}
              </div>
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={
                  selectedModels.size === 0 || importModels.isPending
                }
                onClick={() => importModels.mutate()}
              >
                {importModels.isPending ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                    Importing
                  </>
                ) : (
                  <>
                    <Plus className="h-3 w-3 mr-1.5" />
                    Import Selected
                  </>
                )}
              </Button>
            </div>

            {/* Import result feedback */}
            {importModels.isSuccess && importModels.data && (
              <div className="space-y-1">
                {importModels.data.imported.length > 0 && (
                  <div className="text-xs text-emerald-600 bg-emerald-500/10 px-3 py-1.5 rounded-md">
                    Imported {importModels.data.imported.length} model
                    {importModels.data.imported.length > 1 ? "s" : ""}:{" "}
                    {importModels.data.imported
                      .map((m) => m.name)
                      .join(", ")}
                  </div>
                )}
                {importModels.data.errors.length > 0 && (
                  <div className="text-xs text-amber-600 bg-amber-500/10 px-3 py-1.5 rounded-md">
                    {importModels.data.errors.map((e) => (
                      <div key={e.id}>
                        {e.id}: {e.error}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Connected but no models */}
        {isConnected && !hasModels && (
          <div className="text-xs text-muted-foreground p-3 border border-dashed rounded-lg text-center">
            LM Studio is running but no models are loaded. Load a model in LM Studio and click Refresh.
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
