import { CheckCircle2, XCircle } from "lucide-react";

interface LocalEndpointStatus {
  /** Whether the provider is currently registered/reachable. */
  active: boolean;
  /** Configured endpoint URL, or null when unset. */
  endpoint: string | null;
  /** Display name, e.g. "vLLM". */
  name: string;
  /** Environment variable used to configure the endpoint. */
  envVar: string;
}

interface LocalModelStatusProps {
  vllm: LocalEndpointStatus;
  ollama: LocalEndpointStatus;
}

function EndpointCard({ active, endpoint, name, envVar }: LocalEndpointStatus) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-border">
      {active ? (
        <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
      ) : (
        <XCircle className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      )}
      <div>
        <div className="text-sm font-medium">{name}</div>
        <div className="text-xs text-muted-foreground font-mono">
          {endpoint ?? "Not configured"}
        </div>
        {!endpoint && (
          <p className="text-xs text-muted-foreground mt-1">
            Set via <code className="font-mono">{envVar}</code> environment variable
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Read-only connectivity grid for the self-hosted local providers (vLLM /
 * Ollama). Endpoints are never deleted here — when unset the provider is simply
 * shown as inactive. See issue #346.
 */
export function LocalModelStatus({ vllm, ollama }: LocalModelStatusProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <EndpointCard {...vllm} />
      <EndpointCard {...ollama} />
    </div>
  );
}
