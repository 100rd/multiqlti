import { useState } from "react";
import { useParams, Link } from "wouter";
import { useTrace } from "@/hooks/use-tracing";
import { TraceViewer } from "@/components/tracing/TraceViewer";
import { SpanDetail } from "@/components/tracing/SpanDetail";
import type { TraceSpan } from "@shared/types";
import { Loader2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function TracePage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId ?? "";
  const { trace, isLoading, error } = useTrace(runId);
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading trace...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-destructive">Error loading trace: {error.message}</p>
      </div>
    );
  }

  if (!trace) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">
          No trace available for this run. Tracing may not be enabled.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-14 border-b border-border flex items-center px-6 gap-3 bg-card shrink-0">
        <Link href={`/runs/${runId}`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h2 className="text-sm font-semibold">
          Trace — {runId}
        </h2>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-auto p-4">
          <TraceViewer
            trace={trace}
            onSpanSelect={setSelectedSpan}
            selectedSpanId={selectedSpan?.spanId}
          />
        </main>

        {selectedSpan && (
          <aside className="w-80 border-l border-border overflow-auto p-4">
            <SpanDetail span={selectedSpan} onClose={() => setSelectedSpan(null)} />
          </aside>
        )}
      </div>
    </div>
  );
}
