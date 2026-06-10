/**
 * Final synthesis panel: the run's final deliverable.
 *
 * Renders the orchestrator run `output` (the synthesis step result) as inert,
 * preformatted text. Strings render verbatim; structured output is shown as
 * pretty-printed JSON (via outputToText). When the run failed, the error is
 * surfaced instead.
 *
 * SECURITY: the deliverable is UNTRUSTED model output — rendered as inert React
 * text only (no HTML sink, no markdown-to-HTML).
 */
import { FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { outputToText } from "@/lib/orchestrator";
import type { OrchestratorRun } from "@/lib/orchestrator";

interface SynthesisPanelProps {
  run: OrchestratorRun;
}

export function SynthesisPanel({ run }: SynthesisPanelProps) {
  const text = outputToText(run.output);
  const hasOutput = text.trim().length > 0;

  return (
    <Card data-testid="synthesis-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
          Final synthesis
        </CardTitle>
      </CardHeader>
      <CardContent>
        {run.status === "failed" && run.error ? (
          <p className="text-sm text-destructive break-words" data-testid="synthesis-error">
            {run.error}
          </p>
        ) : hasOutput ? (
          // Untrusted deliverable — inert, preformatted text.
          <pre
            className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-4 text-sm leading-relaxed"
            data-testid="synthesis-output"
          >
            {text}
          </pre>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="synthesis-empty">
            No final deliverable yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
