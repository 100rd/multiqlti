import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import StrategyViewer from "./StrategyViewer";
import SandboxOutput from "./SandboxOutput";
import ThoughtTree from "./ThoughtTree";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { OpenInIdeButton } from "@/components/ui/OpenInIdeButton";
import type { StrategyResult, SandboxResult, ThoughtTree as ThoughtTreeType, ToolCallLogEntry } from "@shared/types";
import ToolCallLog from "./ToolCallLog";

interface StageOutputProps {
  teamId: string;
  teamName: string;
  output: Record<string, unknown>;
  strategyResult?: StrategyResult | null;
  isActive?: boolean;
  thoughtTree?: ThoughtTreeType | null;
  toolCallLog?: ToolCallLogEntry[] | null;
  workspacePath?: string;
}

export default function StageOutput({
  teamId,
  teamName,
  output,
  strategyResult,
  isActive,
  thoughtTree,
  toolCallLog,
  workspacePath,
}: StageOutputProps) {
  const [expanded, setExpanded] = useState(isActive ?? false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (content: string, key: string) => {
    navigator.clipboard.writeText(content);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const summary = (output.summary as string) ?? "";

  // Extract file arrays for code-heavy outputs
  const files =
    (output.files as Array<{
      path: string;
      language?: string;
      content: string;
    }>) ?? [];
  const testFiles =
    (output.testFiles as Array<{
      path: string;
      language?: string;
      content: string;
    }>) ?? [];

  const allFiles = [...files, ...testFiles];
  const sandboxResult = output.sandboxResult as SandboxResult | undefined;

  return (
    <Card className={cn("border-border", isActive && "ring-1 ring-primary/30")}>
      <CardHeader
        className="py-3 px-4 cursor-pointer flex flex-row items-center gap-2"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <CardTitle className="text-sm font-medium">{teamName}</CardTitle>
        {summary && !expanded && (
          <span className="text-xs text-muted-foreground truncate ml-2">
            {summary.slice(0, 80)}...
          </span>
        )}
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 px-4 pb-4 space-y-4">
          {summary && (
            <p className="text-sm text-muted-foreground">{summary}</p>
          )}

          {/* Code files with syntax highlighting */}
          {allFiles.length > 0 && (
            <div className="space-y-3">
              {allFiles.map((file, idx) => (
                <div key={idx} className="rounded-lg border border-border overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                    <span className="text-xs font-mono text-muted-foreground">
                      {file.path}
                    </span>
                    <div className="flex items-center gap-0.5">
                      <OpenInIdeButton filePath={file.path} workspacePath={workspacePath} />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[10px]"
                        onClick={() =>
                          handleCopy(file.content, `${teamId}-${idx}`)
                        }
                      >
                        {copiedKey === `${teamId}-${idx}` ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <CodeBlock
                    code={file.content}
                    language={file.language}
                    filePath={file.path}
                    maxHeight="300px"
                    className="rounded-none border-0"
                  />
                </div>
              ))}
            </div>
          )}

          {/* JSON data (for non-file outputs) with syntax highlighting */}
          {allFiles.length === 0 && (
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b border-border">
                <span className="text-xs font-mono text-muted-foreground">
                  output.json
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px]"
                  onClick={() =>
                    handleCopy(
                      JSON.stringify(output, null, 2),
                      `${teamId}-json`,
                    )
                  }
                >
                  {copiedKey === `${teamId}-json` ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
              </div>
              <CodeBlock
                code={JSON.stringify(output, null, 2)}
                language="json"
                maxHeight="300px"
                className="rounded-none border-0"
              />
            </div>
          )}

          {/* Sandbox result */}
          {sandboxResult && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Sandbox Execution</p>
              <SandboxOutput result={sandboxResult} />
            </div>
          )}

          {/* Thought Tree */}
          {thoughtTree && thoughtTree.length > 0 && (
            <ThoughtTree nodes={thoughtTree} />
          )}

          {/* Tool call log */}
          {toolCallLog && toolCallLog.length > 0 && (
            <ToolCallLog entries={toolCallLog} />
          )}

          {/* Strategy intermediate outputs */}
          {strategyResult && strategyResult.strategy !== "single" && (
            <StrategyViewer strategyResult={strategyResult} />
          )}
        </CardContent>
      )}
    </Card>
  );
}
