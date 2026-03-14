import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShieldCheck, Trash2, Plus, Play, AlertTriangle, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

type AnonymizationLevel = "off" | "standard" | "strict";

interface EntityResult {
  type: string;
  severity: string;
  confidence: number;
  length: number;
  preview: string;
}

interface TestResult {
  anonymized: string;
  entities: EntityResult[];
}

interface CustomPattern {
  id: number;
  name: string;
  entityType: string;
  regexPattern: string;
  severity: string;
  pseudonymTemplate: string | null;
  allowlist: string[];
  createdAt: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/10 text-red-500 border-red-500/30",
  high: "bg-orange-500/10 text-orange-500 border-orange-500/30",
  medium: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  low: "bg-blue-500/10 text-blue-500 border-blue-500/30",
};

const LEVEL_DESCRIPTIONS: Record<AnonymizationLevel, string> = {
  off: "No anonymization applied. All data passes through as-is.",
  standard: "Masks critical and high-severity identifiers: API keys, cloud accounts, IPs, domains, git URLs, env variables.",
  strict: "Masks all detected identifiers including medium and low severity: namespaces, emails, and custom patterns.",
};

function LevelSelector({
  value,
  onChange,
}: {
  value: AnonymizationLevel;
  onChange: (v: AnonymizationLevel) => void;
}) {
  const levels: AnonymizationLevel[] = ["off", "standard", "strict"];
  return (
    <div className="flex gap-2">
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          onClick={() => onChange(level)}
          className={cn(
            "flex-1 px-3 py-2 rounded-md border text-sm font-medium transition-colors capitalize",
            value === level
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
          )}
        >
          {level}
        </button>
      ))}
    </div>
  );
}

function TestPanel() {
  const [text, setText] = useState("");
  const [level, setLevel] = useState<AnonymizationLevel>("standard");
  const [result, setResult] = useState<TestResult | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/privacy/test", { text, level });
      return res.json() as Promise<TestResult>;
    },
    onSuccess: (data) => setResult(data),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Play className="h-4 w-4" />
          Test Anonymization
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Level
          </label>
          <LevelSelector value={level} onChange={setLevel} />
          <p className="text-xs text-muted-foreground mt-2">
            {LEVEL_DESCRIPTIONS[level]}
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">
            Sample Text
          </label>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Paste text containing sensitive data, e.g.:\nDeploy to namespace: prod-payments\nAPI_KEY=sk-abc123xyz789...\nServer: 10.42.3.15`}
            className="min-h-[120px] font-mono text-xs bg-background"
          />
        </div>

        <Button
          onClick={() => mutation.mutate()}
          disabled={!text.trim() || mutation.isPending}
          size="sm"
          className="w-full"
        >
          {mutation.isPending ? "Analyzing..." : "Test Anonymization"}
        </Button>

        {result && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Anonymized Output
              </label>
              <pre className="text-xs bg-muted/50 rounded p-3 border border-border whitespace-pre-wrap font-mono">
                {result.anonymized}
              </pre>
            </div>

            {result.entities.length > 0 && (
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block">
                  Detected Entities ({result.entities.length})
                </label>
                <div className="space-y-1.5">
                  {result.entities.map((e, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 p-2 rounded border border-border bg-muted/20 text-xs"
                    >
                      <span className="font-mono text-foreground">{e.preview}</span>
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] px-1.5 py-0",
                            SEVERITY_COLORS[e.severity] ?? "",
                          )}
                        >
                          {e.severity}
                        </Badge>
                        <span className="text-muted-foreground">{e.type}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.entities.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">
                No entities detected at this level.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PatternsTable() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newRegex, setNewRegex] = useState("");
  const [newEntityType, setNewEntityType] = useState("custom_pattern");
  const [newSeverity, setNewSeverity] = useState<string>("high");
  const [regexError, setRegexError] = useState<string | null>(null);

  const { data: patterns = [] } = useQuery<CustomPattern[]>({
    queryKey: ["/api/privacy/patterns"],
    queryFn: async () => {
      const res = await fetch("/api/privacy/patterns");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/privacy/patterns", {
        name: newName,
        regexPattern: newRegex,
        entityType: newEntityType,
        severity: newSeverity,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/patterns"] });
      setNewName("");
      setNewRegex("");
      setNewEntityType("custom_pattern");
      setNewSeverity("high");
      setRegexError(null);
    },
    onError: (err: Error) => setRegexError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/privacy/patterns/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/patterns"] });
    },
  });

  const validateAndSubmit = () => {
    try {
      new RegExp(newRegex);
      setRegexError(null);
    } catch (e) {
      setRegexError("Invalid regular expression");
      return;
    }
    if (!newName.trim() || !newRegex.trim()) {
      setRegexError("Name and regex are required");
      return;
    }
    createMutation.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Lock className="h-4 w-4" />
          Custom Detection Patterns
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-3 rounded border border-border bg-muted/20 space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Add Pattern
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Internal hostname"
                className="h-7 text-xs bg-background"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Entity Type</label>
              <Input
                value={newEntityType}
                onChange={(e) => setNewEntityType(e.target.value)}
                placeholder="custom_pattern"
                className="h-7 text-xs bg-background"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Regex Pattern</label>
            <Input
              value={newRegex}
              onChange={(e) => setNewRegex(e.target.value)}
              placeholder="e.g. corp-[a-z0-9]+-\d+"
              className="h-7 text-xs font-mono bg-background"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Severity</label>
            <Select value={newSeverity} onValueChange={setNewSeverity}>
              <SelectTrigger className="h-7 text-xs bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {regexError && (
            <p className="text-xs text-red-500 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              {regexError}
            </p>
          )}

          <Button
            onClick={validateAndSubmit}
            size="sm"
            disabled={createMutation.isPending}
            className="w-full"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add Pattern
          </Button>
        </div>

        <ScrollArea className="max-h-64">
          {patterns.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No custom patterns defined.
            </p>
          ) : (
            <div className="space-y-2">
              {patterns.map((p) => (
                <div
                  key={p.id}
                  className="flex items-start justify-between gap-2 p-2.5 rounded border border-border bg-muted/10"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-medium truncate">{p.name}</span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px] px-1 py-0 shrink-0",
                          SEVERITY_COLORS[p.severity] ?? "",
                        )}
                      >
                        {p.severity}
                      </Badge>
                    </div>
                    <code className="text-[10px] text-muted-foreground font-mono block truncate">
                      {p.regexPattern}
                    </code>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-red-500"
                    onClick={() => deleteMutation.mutate(p.id)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export default function Privacy() {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Privacy &amp; Compliance</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          Configure the Privacy Proxy Layer to pseudonymize sensitive identifiers before they reach public LLM APIs.
          Disabled by default — opt-in per pipeline stage.
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6 max-w-3xl">
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                <div className="text-xs text-amber-700 dark:text-amber-400 space-y-1">
                  <p className="font-medium">Privacy proxy is opt-in per pipeline stage</p>
                  <p className="text-muted-foreground">
                    Enable it in each Agent Node's Advanced settings. Real values are never stored in the audit log.
                    In-memory vault is cleared after the session TTL (default 1 hour).
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <TestPanel />
          <PatternsTable />
        </div>
      </ScrollArea>
    </div>
  );
}
