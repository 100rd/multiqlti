import { useState } from "react";
import { ChevronDown, ChevronRight, Clock, AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCallLogEntry } from "@shared/types";

interface ToolCallLogProps {
  entries: ToolCallLogEntry[];
}

function ToolCallEntry({ entry }: { entry: ToolCallLogEntry }) {
  const [argsOpen, setArgsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);

  const isError = entry.result.isError;

  return (
    <div className="border border-border rounded-md overflow-hidden text-xs">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
        {isError ? (
          <AlertCircle className="h-3 w-3 text-destructive shrink-0" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
        )}
        <span className="font-mono font-medium text-foreground">{entry.call.name}</span>
        <span className="text-muted-foreground">iteration {entry.iteration}</span>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          <Clock className="h-3 w-3" />
          {entry.durationMs}ms
        </span>
      </div>

      {/* Args section */}
      <div className="border-t border-border">
        <button
          className="w-full flex items-center gap-1 px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors"
          onClick={() => setArgsOpen(!argsOpen)}
        >
          {argsOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <span>Arguments</span>
        </button>
        {argsOpen && (
          <div className="px-3 py-2 bg-muted/10 border-t border-border">
            <pre className="whitespace-pre-wrap break-words text-xs font-mono text-foreground">
              {JSON.stringify(entry.call.arguments, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Result section */}
      <div className="border-t border-border">
        <button
          className="w-full flex items-center gap-1 px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors"
          onClick={() => setResultOpen(!resultOpen)}
        >
          {resultOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <span className={cn(isError ? "text-destructive" : "")}>
            {isError ? "Error" : "Result"}
          </span>
        </button>
        {resultOpen && (
          <div className={cn(
            "px-3 py-2 border-t border-border",
            isError ? "bg-destructive/5" : "bg-muted/10",
          )}>
            <pre className={cn(
              "whitespace-pre-wrap break-words text-xs font-mono",
              isError ? "text-destructive" : "text-foreground",
            )}>
              {entry.result.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ToolCallLog({ entries }: ToolCallLogProps) {
  if (entries.length === 0) return null;

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        Tool Calls ({entries.length})
      </p>
      <div className="space-y-2">
        {entries.map((entry, idx) => (
          <ToolCallEntry key={idx} entry={entry} />
        ))}
      </div>
    </div>
  );
}
