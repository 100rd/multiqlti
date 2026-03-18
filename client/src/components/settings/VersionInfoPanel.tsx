import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Copy, RefreshCw } from "lucide-react";
import { apiRequest } from "@/hooks/use-pipeline";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { VersionsResponse } from "@shared/types";

// ─── Badge helper ─────────────────────────────────────────────────────────────

type BadgeVariant = "present" | "dev" | "na";

function versionBadgeVariant(version: string | null | undefined): BadgeVariant {
  if (version === null || version === undefined) return "na";
  if (version === "dev") return "dev";
  return "present";
}

const BADGE_CLASSES: Record<BadgeVariant, string> = {
  present: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  dev: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  na: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500",
};

interface VersionBadgeProps {
  version: string | null | undefined;
}

function VersionBadge({ version }: VersionBadgeProps) {
  const variant = versionBadgeVariant(version);
  const label = version ?? "N/A";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-mono font-medium",
        BADGE_CLASSES[variant],
      )}
    >
      {label}
    </span>
  );
}

// ─── Copy button ──────────────────────────────────────────────────────────────

interface CopyButtonProps {
  value: string | null | undefined;
}

function CopyButton({ value }: CopyButtonProps) {
  if (!value || value === "N/A") return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(value).catch(() => {
      // clipboard API unavailable — silently ignore
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      aria-label={`Copy ${value}`}
      title="Copy to clipboard"
    >
      <Copy className="h-3.5 w-3.5" />
    </button>
  );
}

// ─── Single version row ───────────────────────────────────────────────────────

interface VersionRowProps {
  label: string;
  version: string | null | undefined;
}

function VersionRow({ label, version }: VersionRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <VersionBadge version={version} />
        <CopyButton value={version} />
      </div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function VersionRowSkeleton() {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-5 w-16 rounded" />
    </div>
  );
}

// ─── Section divider ──────────────────────────────────────────────────────────

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-4 mb-1 first:mt-0">
      {children}
    </p>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function VersionInfoPanel() {
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery<VersionsResponse>({
    queryKey: ["versions"],
    queryFn: () => apiRequest("GET", "/api/settings/versions") as Promise<VersionsResponse>,
    staleTime: 60_000, // 1 minute — versions don't change mid-session
  });

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ["versions"] });
  };

  return (
    <div className="p-4 space-y-1">
      {/* Header row with Refresh button */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-muted-foreground">
          Live component versions and build metadata.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1.5"
          onClick={handleRefresh}
          disabled={isLoading}
          aria-label="Refresh version information"
        >
          <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {isError && (
        <p className="text-xs text-destructive py-2">
          Failed to load version information. Check server connectivity.
        </p>
      )}

      {/* Platform group */}
      <GroupLabel>Platform</GroupLabel>

      {isLoading ? (
        <>
          <VersionRowSkeleton />
          <VersionRowSkeleton />
          <VersionRowSkeleton />
          <VersionRowSkeleton />
          <VersionRowSkeleton />
        </>
      ) : data ? (
        <>
          <VersionRow label="Frontend" version={data.platform.frontend} />
          <VersionRow label="Backend" version={data.platform.backend} />
          <VersionRow label="Node.js" version={data.platform.node} />
          <VersionRow label="Build Date" version={data.platform.buildDate} />
          <VersionRow label="Git Commit" version={data.platform.gitCommit} />
        </>
      ) : null}

      {/* Connected services group */}
      <GroupLabel>Connected Services</GroupLabel>

      {isLoading ? (
        <>
          <VersionRowSkeleton />
          <VersionRowSkeleton />
          <VersionRowSkeleton />
          <VersionRowSkeleton />
        </>
      ) : data ? (
        <>
          <VersionRow label="Docker Engine" version={data.runtimes.docker} />
          <VersionRow label="vLLM" version={data.runtimes.vllm} />
          <VersionRow label="Ollama" version={data.runtimes.ollama} />
          <VersionRow label="PostgreSQL" version={data.database.postgres} />
        </>
      ) : null}
    </div>
  );
}
