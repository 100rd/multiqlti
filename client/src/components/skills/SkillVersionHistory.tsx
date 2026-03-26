import { memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RotateCcw, Clock } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillVersionRecord {
  id: string;
  skillId: string;
  version: string;
  config: Record<string, unknown>;
  changelog: string;
  createdBy: string;
  createdAt: string;
}

interface VersionsResponse {
  rows: SkillVersionRecord[];
  total: number;
}

interface SkillVersionHistoryProps {
  skillId: string;
  isOwner: boolean;
  onRollback: (version: string) => void;
  isRollbackPending: boolean;
}

// ─── Fetcher ─────────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function fetchVersions(skillId: string): Promise<VersionsResponse> {
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`/api/skills/${skillId}/versions?limit=50`, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error((err.error ?? err.message ?? res.statusText) as string);
  }
  return res.json() as Promise<VersionsResponse>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export const SkillVersionHistory = memo(function SkillVersionHistory({
  skillId,
  isOwner,
  onRollback,
  isRollbackPending,
}: SkillVersionHistoryProps) {
  const { data, isLoading, error } = useQuery<VersionsResponse>({
    queryKey: ["skill-versions", skillId],
    queryFn: () => fetchVersions(skillId),
    enabled: Boolean(skillId),
  });

  if (isLoading) {
    return (
      <div className="space-y-3 py-2" role="status" aria-label="Loading version history">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <p className="text-sm text-destructive">Failed to load version history.</p>
        <p className="text-xs text-muted-foreground mt-1">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Clock className="h-6 w-6 text-muted-foreground/40 mb-2" />
        <p className="text-xs text-muted-foreground">No version history yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-2" role="list" aria-label="Version history">
      {data.rows.map((version, index) => (
        <div
          key={version.id}
          role="listitem"
          className="relative flex items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted/30 transition-colors"
        >
          {/* Timeline connector */}
          {index < data.rows.length - 1 && (
            <div className="absolute left-[21px] top-[38px] bottom-[-10px] w-px bg-border" />
          )}

          {/* Timeline dot */}
          <div className="shrink-0 mt-1 h-3 w-3 rounded-full border-2 border-primary bg-background" />

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 font-mono">
                v{version.version}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {formatDate(version.createdAt)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                by {version.createdBy}
              </span>
            </div>
            {version.changelog && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {version.changelog}
              </p>
            )}
          </div>

          {/* Rollback button */}
          {isOwner && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] px-2 gap-1 shrink-0"
              onClick={() => onRollback(version.version)}
              disabled={isRollbackPending}
              aria-label={`Rollback to version ${version.version}`}
            >
              <RotateCcw className="h-3 w-3" />
              Rollback
            </Button>
          )}
        </div>
      ))}

      {data.total > data.rows.length && (
        <p className="text-[10px] text-muted-foreground text-center pt-2">
          Showing {data.rows.length} of {data.total} versions
        </p>
      )}
    </div>
  );
});
