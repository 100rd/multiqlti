import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Copy, Check } from "lucide-react";

interface StageErrorProps {
  teamName: string;
  error: string;
}

const COPY_RESET_MS = 2000;

/**
 * Persisted failure panel for a stage. Surfaces the error message stored on
 * `stage_executions.error` so users can self-diagnose after a page reload,
 * when the live WebSocket `stage:failed` event is no longer available.
 * See issue #342.
 */
export default function StageError({ teamName, error }: StageErrorProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(error);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_RESET_MS);
  };

  return (
    <Card
      role="alert"
      className="border-red-500/40 bg-red-500/5"
      data-testid="stage-error"
    >
      <CardHeader className="py-3 px-4 flex flex-row items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-red-600" aria-hidden="true" />
        <CardTitle className="text-sm font-medium text-red-700">
          {teamName} — Error
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 text-[10px]"
          onClick={handleCopy}
          aria-label="Copy error message"
        >
          {copied ? (
            <Check className="h-3 w-3" aria-hidden="true" />
          ) : (
            <Copy className="h-3 w-3" aria-hidden="true" />
          )}
        </Button>
      </CardHeader>
      <CardContent className="pt-0 px-4 pb-4">
        <pre className="whitespace-pre-wrap break-words rounded-md border border-red-500/30 bg-background/60 p-3 text-xs font-mono text-red-700">
          {error}
        </pre>
      </CardContent>
    </Card>
  );
}
