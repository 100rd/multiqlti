import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Terminal, Clock } from "lucide-react";
import type { SandboxResult } from "@shared/types";

interface SandboxOutputProps {
  result: SandboxResult;
  liveLines?: Array<{ stream: "stdout" | "stderr"; data: string }>;
  isRunning?: boolean;
  startedAt?: number;
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return <span className="font-mono text-[10px] text-muted-foreground">{elapsed}s</span>;
}

export default function SandboxOutput({
  result,
  liveLines,
  isRunning,
  startedAt,
}: SandboxOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveLines, expanded]);

  const passed = !isRunning && result.exitCode === 0 && !result.timedOut;
  const failed = !isRunning && (result.exitCode !== 0 || result.timedOut);

  const stdoutLines = result.stdout.split("\n").filter(Boolean);
  const stderrLines = result.stderr.split("\n").filter(Boolean);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-zinc-900 hover:bg-zinc-800 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        )}
        <Terminal className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        <span className="text-xs text-zinc-300 font-mono flex-1 truncate">
          {result.image}
        </span>

        {isRunning && startedAt && <ElapsedTimer startedAt={startedAt} />}

        {isRunning && (
          <Badge className="text-[10px] h-4 px-1.5 bg-blue-500/20 text-blue-400 border-blue-500/30">
            running
          </Badge>
        )}
        {passed && (
          <Badge className="text-[10px] h-4 px-1.5 bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
            exit 0
          </Badge>
        )}
        {failed && (
          <Badge className="text-[10px] h-4 px-1.5 bg-red-500/20 text-red-400 border-red-500/30">
            {result.timedOut ? "timed out" : `exit ${result.exitCode}`}
          </Badge>
        )}

        {!isRunning && (
          <span className="flex items-center gap-1 text-[10px] text-zinc-500 font-mono">
            <Clock className="h-3 w-3" />
            {(result.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </button>

      {expanded && (
        <div
          ref={scrollRef}
          className="bg-zinc-950 max-h-[400px] overflow-y-auto p-3 space-y-0.5"
        >
          {result.timedOut && (
            <div className="text-amber-400 text-xs font-mono mb-2">
              [container killed: timeout exceeded]
            </div>
          )}

          {liveLines && liveLines.length > 0 ? (
            liveLines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "text-xs font-mono whitespace-pre-wrap leading-relaxed",
                  line.stream === "stderr" ? "text-amber-400" : "text-zinc-100",
                )}
              >
                {line.data}
              </div>
            ))
          ) : (
            <>
              {stdoutLines.map((line, i) => (
                <div key={`out-${i}`} className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-100">
                  {line}
                </div>
              ))}
              {stderrLines.map((line, i) => (
                <div key={`err-${i}`} className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-amber-400">
                  {line}
                </div>
              ))}
            </>
          )}

          {!isRunning && stdoutLines.length === 0 && stderrLines.length === 0 && (
            <div className="text-zinc-600 text-xs font-mono">(no output)</div>
          )}
        </div>
      )}
    </div>
  );
}
