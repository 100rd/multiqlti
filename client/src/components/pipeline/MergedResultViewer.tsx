import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, ChevronRight, Copy, Check, Merge, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/ui/CodeBlock";

const MERGE_STRATEGY_LABELS: Record<string, string> = {
  auto: "auto",
  concatenate: "concatenate",
  review: "LLM review",
  llm_merge: "LLM merge",
  vote: "vote",
};

interface SubtaskOutput {
  subtaskId: string;
  title: string;
  modelSlug: string;
  output: string;
  tokensUsed?: number;
  durationMs?: number;
  status: "completed" | "failed";
  error?: string;
}

interface MergedResultViewerProps {
  teamName: string;
  mergeStrategy: string;
  subtaskOutputs: SubtaskOutput[];
  mergedOutput?: Record<string, unknown>;
  isActive?: boolean;
}

export default function MergedResultViewer({
  teamName,
  mergeStrategy,
  subtaskOutputs,
  mergedOutput,
  isActive,
}: MergedResultViewerProps) {
  const [expanded, setExpanded] = useState(isActive ?? false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (content: string, key: string) => {
    navigator.clipboard.writeText(content);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const succeededCount = subtaskOutputs.filter((s) => s.status === "completed").length;
  const failedCount = subtaskOutputs.filter((s) => s.status === "failed").length;

  return (
    <Card className={cn("border-border", isActive && "ring-1 ring-primary/30")}>
      <CardHeader
        className="py-3 px-4 cursor-pointer flex flex-row items-center gap-2"
        onClick={() => setExpanded(!expanded)}
        role="button"
        aria-expanded={expanded}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <Merge className="h-4 w-4 text-muted-foreground" />
        <CardTitle className="text-sm font-medium">{teamName}</CardTitle>
        <Badge variant="outline" className="text-[10px] h-4 px-1.5 ml-2">
          {succeededCount} subtask{succeededCount !== 1 ? "s" : ""} merged
          {failedCount > 0 && ` · ${failedCount} failed`}
        </Badge>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
          {MERGE_STRATEGY_LABELS[mergeStrategy] ?? mergeStrategy}
        </Badge>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 px-4 pb-4">
          <Tabs defaultValue="merged" className="w-full">
            <TabsList className="w-full justify-start mb-3">
              <TabsTrigger value="merged" className="text-xs">
                Merged Output
              </TabsTrigger>
              {subtaskOutputs.map((st, idx) => (
                <TabsTrigger
                  key={st.subtaskId}
                  value={st.subtaskId}
                  className={cn(
                    "text-xs",
                    st.status === "failed" && "text-destructive",
                  )}
                >
                  {st.title || `Subtask ${idx + 1}`}
                  {st.status === "failed" && (
                    <AlertTriangle className="h-3 w-3 ml-1 text-destructive" />
                  )}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* Merged output tab */}
            <TabsContent value="merged">
              {mergedOutput ? (
                <div className="rounded-lg border border-border overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                    <span className="text-xs font-mono text-muted-foreground">
                      merged-output.json
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[10px]"
                      onClick={() => handleCopy(JSON.stringify(mergedOutput, null, 2), "merged")}
                    >
                      {copiedKey === "merged" ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <CodeBlock
                    code={JSON.stringify(mergedOutput, null, 2)}
                    language="json"
                    maxHeight="400px"
                    className="rounded-none border-0"
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  Merged output not yet available.
                </p>
              )}
            </TabsContent>

            {/* Per-subtask tabs */}
            {subtaskOutputs.map((st) => (
              <TabsContent key={st.subtaskId} value={st.subtaskId}>
                <div className="space-y-3">
                  {/* Subtask metadata */}
                  <div className="flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
                    <span className="font-mono">{st.modelSlug}</span>
                    {st.tokensUsed !== undefined && (
                      <span>{st.tokensUsed.toLocaleString()} tokens</span>
                    )}
                    {st.durationMs !== undefined && (
                      <span>
                        {st.durationMs < 1000
                          ? `${st.durationMs}ms`
                          : `${(st.durationMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[9px] h-4 px-1",
                        st.status === "completed"
                          ? "border-green-500/50 text-green-600"
                          : "border-red-500/50 text-red-600",
                      )}
                    >
                      {st.status}
                    </Badge>
                  </div>

                  {/* Error display */}
                  {st.error && (
                    <div className="flex items-start gap-1.5 px-3 py-2 rounded bg-destructive/5 border border-destructive/20">
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                      <pre className="text-xs text-destructive whitespace-pre-wrap font-mono break-all">
                        {st.error}
                      </pre>
                    </div>
                  )}

                  {/* Output content */}
                  {st.output && (
                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                        <span className="text-xs font-mono text-muted-foreground">
                          subtask-{st.subtaskId.slice(0, 8)}.txt
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[10px]"
                          onClick={() => handleCopy(st.output, `subtask-${st.subtaskId}`)}
                        >
                          {copiedKey === `subtask-${st.subtaskId}` ? (
                            <Check className="h-3 w-3" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                      <ScrollArea className="max-h-[400px]">
                        <pre className="p-3 text-xs font-mono whitespace-pre-wrap">
                          {st.output}
                        </pre>
                      </ScrollArea>
                    </div>
                  )}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      )}
    </Card>
  );
}
