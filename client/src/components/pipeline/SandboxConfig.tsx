import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, Container, AlertTriangle, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SANDBOX_IMAGE_PRESETS, SANDBOX_DEFAULTS } from "@shared/constants";
import type { SandboxConfig as SandboxConfigType } from "@shared/types";

type PresetKey = keyof typeof SANDBOX_IMAGE_PRESETS;

const MEMORY_OPTIONS = ["256m", "512m", "1g", "2g"] as const;
const CPU_OPTIONS = [0.5, 1.0, 2.0] as const;

interface SandboxConfigProps {
  config?: SandboxConfigType;
  enabled: boolean;
  onChange: (config: SandboxConfigType | undefined) => void;
}

type TestStatus = "idle" | "loading" | "ok" | "error";

export default function SandboxConfig({ config, enabled, onChange }: SandboxConfigProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<PresetKey>("node");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState("");

  const sandboxEnabled = config?.enabled ?? false;

  const handleToggleSandbox = (on: boolean) => {
    if (!on) {
      onChange(undefined);
      return;
    }
    const preset = SANDBOX_IMAGE_PRESETS[selectedPreset];
    onChange({
      enabled: true,
      image: preset.image,
      command: preset.testCmd,
      installCommand: preset.installCmd || undefined,
      workdir: SANDBOX_DEFAULTS.workdir,
      timeout: SANDBOX_DEFAULTS.timeout,
      memoryLimit: SANDBOX_DEFAULTS.memoryLimit,
      cpuLimit: SANDBOX_DEFAULTS.cpuLimit,
      networkEnabled: SANDBOX_DEFAULTS.networkEnabled,
      failOnNonZero: SANDBOX_DEFAULTS.failOnNonZero,
    });
  };

  const handlePresetChange = (key: PresetKey) => {
    setSelectedPreset(key);
    if (!config?.enabled) return;
    const preset = SANDBOX_IMAGE_PRESETS[key];
    onChange({
      ...config,
      image: preset.image,
      command: preset.testCmd,
      installCommand: preset.installCmd || undefined,
    });
  };

  const update = (patch: Partial<SandboxConfigType>) => {
    if (!config) return;
    onChange({ ...config, ...patch });
  };

  const handleTestImage = async () => {
    if (!config?.image) return;
    setTestStatus("loading");
    setTestError("");
    try {
      const res = await fetch("/api/sandbox/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: config.image, timeout: 30 }),
      });
      const data = await res.json() as { exitCode?: number; message?: string };
      if (!res.ok || data.exitCode !== 0) {
        setTestStatus("error");
        setTestError(data.message ?? `Exit code ${data.exitCode}`);
      } else {
        setTestStatus("ok");
      }
    } catch (e) {
      setTestStatus("error");
      setTestError((e as Error).message);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        disabled={!enabled}
      >
        <Container className="h-3 w-3" />
        <span>Sandbox execution</span>
        {expanded
          ? <ChevronUp className="h-3 w-3 ml-1" />
          : <ChevronDown className="h-3 w-3 ml-1" />}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 p-3 rounded border border-border bg-muted/30">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">Enable sandbox execution</label>
            <Switch
              checked={sandboxEnabled}
              onCheckedChange={handleToggleSandbox}
              disabled={!enabled}
            />
          </div>

          {sandboxEnabled && config && (
            <>
              {/* Preset picker */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Runtime preset</label>
                <Select value={selectedPreset} onValueChange={(v) => handlePresetChange(v as PresetKey)} disabled={!enabled}>
                  <SelectTrigger className="h-8 text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SANDBOX_IMAGE_PRESETS) as PresetKey[]).map((key) => (
                      <SelectItem key={key} value={key} className="text-xs">
                        {key === "custom" ? "Custom" : key} {key !== "custom" && `(${SANDBOX_IMAGE_PRESETS[key].image})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Image */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Image</label>
                <div className="flex gap-2">
                  <Input
                    className="h-7 text-xs bg-background border-border flex-1"
                    value={config.image}
                    onChange={(e) => update({ image: e.target.value })}
                    placeholder="node:20-alpine"
                    disabled={!enabled}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px] px-2 shrink-0"
                    onClick={handleTestImage}
                    disabled={!enabled || testStatus === "loading" || !config.image}
                  >
                    {testStatus === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
                    {testStatus === "ok" && <CheckCircle className="h-3 w-3 text-emerald-500" />}
                    {testStatus === "error" && <XCircle className="h-3 w-3 text-red-500" />}
                    {testStatus === "idle" && "Test"}
                  </Button>
                </div>
                {testStatus === "error" && (
                  <p className="text-[10px] text-red-500 mt-1">{testError}</p>
                )}
                {testStatus === "ok" && (
                  <p className="text-[10px] text-emerald-500 mt-1">Image is available</p>
                )}
              </div>

              {/* Command */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Command</label>
                <Input
                  className="h-7 text-xs bg-background border-border font-mono"
                  value={config.command}
                  onChange={(e) => update({ command: e.target.value })}
                  placeholder="npm test"
                  disabled={!enabled}
                />
              </div>

              {/* Install command */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Install command <span className="text-muted-foreground/60">(optional)</span>
                </label>
                <Input
                  className="h-7 text-xs bg-background border-border font-mono"
                  value={config.installCommand ?? ""}
                  onChange={(e) => update({ installCommand: e.target.value || undefined })}
                  placeholder="npm install"
                  disabled={!enabled}
                />
              </div>

              {/* Timeout */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-muted-foreground">Timeout</label>
                  <span className="text-xs font-mono text-foreground">{config.timeout ?? SANDBOX_DEFAULTS.timeout}s</span>
                </div>
                <Slider
                  min={30}
                  max={600}
                  step={30}
                  value={[config.timeout ?? SANDBOX_DEFAULTS.timeout]}
                  onValueChange={([val]) => update({ timeout: val })}
                  disabled={!enabled}
                  className="h-4"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                  <span>30s</span>
                  <span>600s</span>
                </div>
              </div>

              {/* Memory limit */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Memory limit</label>
                <Select
                  value={config.memoryLimit ?? SANDBOX_DEFAULTS.memoryLimit}
                  onValueChange={(v) => update({ memoryLimit: v })}
                  disabled={!enabled}
                >
                  <SelectTrigger className="h-8 text-xs bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MEMORY_OPTIONS.map((m) => (
                      <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* CPU limit */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-muted-foreground">CPU limit</label>
                  <span className="text-xs font-mono text-foreground">{config.cpuLimit ?? SANDBOX_DEFAULTS.cpuLimit}</span>
                </div>
                <Slider
                  min={0}
                  max={2}
                  step={1}
                  value={[CPU_OPTIONS.indexOf((config.cpuLimit ?? SANDBOX_DEFAULTS.cpuLimit) as 0.5 | 1 | 2)]}
                  onValueChange={([idx]) => update({ cpuLimit: CPU_OPTIONS[idx] })}
                  disabled={!enabled}
                  className="h-4"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                  {CPU_OPTIONS.map((c) => <span key={c}>{c}</span>)}
                </div>
              </div>

              {/* Network */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Network access</label>
                  {config.networkEnabled && (
                    <div className={cn("flex items-center gap-1 mt-0.5")}>
                      <AlertTriangle className="h-2.5 w-2.5 text-amber-500" />
                      <span className="text-[10px] text-amber-500">Container will have network access</span>
                    </div>
                  )}
                </div>
                <Switch
                  checked={config.networkEnabled ?? SANDBOX_DEFAULTS.networkEnabled}
                  onCheckedChange={(v) => update({ networkEnabled: v })}
                  disabled={!enabled}
                />
              </div>

              {/* Fail on non-zero */}
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Fail stage on non-zero exit</label>
                <Switch
                  checked={config.failOnNonZero ?? SANDBOX_DEFAULTS.failOnNonZero}
                  onCheckedChange={(v) => update({ failOnNonZero: v })}
                  disabled={!enabled}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
