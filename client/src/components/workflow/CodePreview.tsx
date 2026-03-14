import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Copy, Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useRuns, usePipelineRun } from "@/hooks/use-pipeline";

interface CodeFile {
  path: string;
  language?: string;
  content: string;
  description?: string;
}

interface Run {
  id: string;
  pipelineId?: string;
}

interface StageExecution {
  teamId: string;
  output?: Record<string, unknown>;
}

interface CodePreviewProps {
  pipelineId?: string;
}

export default function CodePreview({ pipelineId }: CodePreviewProps) {
  const { data: runs } = useRuns(pipelineId);
  const scopedRuns: Run[] = Array.isArray(runs) ? runs : [];
  const latestRun = scopedRuns.length > 0 ? scopedRuns[0] : null;
  const { data: runData } = usePipelineRun(latestRun?.id ?? "");

  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (content: string, key: string) => {
    navigator.clipboard.writeText(content);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Collect code files from all stage outputs
  const codeFiles: (CodeFile & { team: string })[] = [];
  const stages: StageExecution[] = runData?.stages ?? [];
  for (const stage of stages) {
    if (!stage.output) continue;
    const output = stage.output as Record<string, unknown>;
    const files = (output.files as CodeFile[]) ?? [];
    const testFiles = (output.testFiles as CodeFile[]) ?? [];
    for (const f of [...files, ...testFiles]) {
      codeFiles.push({ ...f, team: stage.teamId });
    }
  }

  if (codeFiles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm py-12">
        <p>No generated code yet.</p>
        <p className="text-xs mt-1">
          Execute a pipeline — code from Development, Testing, and Deployment stages will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div className="space-y-3 flex-1 overflow-y-auto">
        {codeFiles.map((block, idx) => {
          const key = `${block.team}-${idx}`;
          const isExpanded = expandedFile === key;
          return (
            <Card
              key={key}
              className={cn(
                "border-border bg-card overflow-hidden transition-all",
                isExpanded ? "ring-1 ring-primary/50" : "",
              )}
            >
              <button
                onClick={() => setExpandedFile(isExpanded ? null : key)}
                className="w-full flex items-center justify-between p-4 hover:bg-accent/50 transition-colors"
              >
                <div className="text-left flex-1">
                  <div className="font-mono font-medium text-sm">{block.path}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {block.team}{block.language ? ` · ${block.language}` : ""}
                  </div>
                </div>
                <ChevronDown className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  isExpanded ? "rotate-180" : "",
                )} />
              </button>

              {isExpanded && (
                <>
                  <div className="border-t border-border px-4 py-3 bg-muted/50">
                    <div className="flex items-center gap-2">
                      {block.language && (
                        <span className="text-xs font-mono text-muted-foreground px-2 py-1 rounded bg-background">
                          {block.language}
                        </span>
                      )}
                      {block.description && (
                        <span className="text-xs text-muted-foreground truncate">{block.description}</span>
                      )}
                      <div className="ml-auto">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleCopy(block.content, key)}
                        >
                          {copiedKey === key
                            ? <Check className="h-3 w-3 mr-1" />
                            : <Copy className="h-3 w-3 mr-1" />}
                          Copy
                        </Button>
                      </div>
                    </div>
                  </div>

                  <pre className="p-4 bg-background text-foreground text-xs font-mono overflow-x-auto max-h-96 border-t border-border">
                    <code>{block.content}</code>
                  </pre>
                </>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="border-border bg-muted/30 p-3 border-t-2 border-t-emerald-500 shrink-0">
        <div className="text-xs space-y-1">
          <div className="font-medium text-emerald-700">
            {codeFiles.length} file{codeFiles.length !== 1 ? "s" : ""} generated
          </div>
          <div className="text-muted-foreground">
            From {new Set(codeFiles.map(f => f.team)).size} pipeline stages
          </div>
        </div>
      </Card>
    </div>
  );
}
