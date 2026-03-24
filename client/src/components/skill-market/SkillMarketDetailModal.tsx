import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Download,
  Check,
  TrendingUp,
  ExternalLink,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSkillMarketDetails } from "@/hooks/useSkillMarket";
import type { SkillMarketSearchResult } from "@/hooks/useSkillMarket";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillMarketDetailModalProps {
  skill: SkillMarketSearchResult | null;
  open: boolean;
  onClose: () => void;
  onInstall: (externalId: string, source: string) => void;
  isInstallPending: boolean;
  installed?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  "mcp-registry": "bg-blue-500/15 text-blue-600 border-blue-500/30",
  composio: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  "crewai-github": "bg-green-500/15 text-green-600 border-green-500/30",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function SkillMarketDetailModal({
  skill,
  open,
  onClose,
  onInstall,
  isInstallPending,
  installed,
}: SkillMarketDetailModalProps) {
  const { data: details, isLoading } = useSkillMarketDetails(
    skill?.source ?? "",
    skill?.externalId ?? "",
  );

  if (!skill) return null;

  const sourceBadgeClass =
    SOURCE_COLORS[skill.source] ?? "bg-muted text-muted-foreground border-border";

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className="max-w-2xl max-h-[80vh] flex flex-col"
        aria-describedby="skill-market-detail-description"
      >
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold">
                {skill.name}
              </DialogTitle>
              <DialogDescription
                id="skill-market-detail-description"
                className="text-xs mt-1"
              >
                {skill.description || "No description available."}
              </DialogDescription>
            </div>
          </div>

          {/* Metadata badges */}
          <div className="flex items-center gap-2 flex-wrap pt-2">
            {skill.version && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 font-mono"
              >
                v{skill.version}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] px-1.5 py-0.5 border flex items-center gap-1",
                sourceBadgeClass,
              )}
            >
              {skill.icon && (
                <img
                  src={skill.icon}
                  alt=""
                  className="h-3 w-3 rounded-sm"
                  aria-hidden="true"
                />
              )}
              {skill.source}
            </Badge>
            {skill.popularity != null && skill.popularity > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 border bg-primary/5 text-primary border-primary/20 flex items-center gap-1"
              >
                <TrendingUp className="h-2.5 w-2.5" />
                {skill.popularity}
              </Badge>
            )}
            {skill.author && (
              <span className="text-[10px] text-muted-foreground">
                by {skill.author}
              </span>
            )}
          </div>

          {/* Tags */}
          {skill.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {skill.tags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0.5"
                >
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </DialogHeader>

        {/* Actions bar */}
        <div className="flex items-center gap-2 border-t border-b border-border py-2">
          {installed ? (
            <Badge
              variant="outline"
              className="text-xs px-2 py-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 flex items-center gap-1"
            >
              <Check className="h-3.5 w-3.5" />
              Installed
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs gap-1.5"
              onClick={() => onInstall(skill.externalId, skill.source)}
              disabled={isInstallPending}
              aria-label={`Install ${skill.name}`}
            >
              <Download className="h-3.5 w-3.5" />
              {isInstallPending ? "Installing..." : "Install"}
            </Button>
          )}
          {details?.repository && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              asChild
            >
              <a
                href={details.repository}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Repository
              </a>
            </Button>
          )}
          {details?.homepage && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              asChild
            >
              <a
                href={details.homepage}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Homepage
              </a>
            </Button>
          )}
        </div>

        {/* Detail content */}
        <div className="flex-1 overflow-y-auto space-y-4">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-32 w-full rounded-md" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-16 w-full rounded-md" />
            </div>
          ) : details ? (
            <>
              {/* README */}
              {details.readme && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" />
                    README
                  </div>
                  <div className="rounded-md border border-border bg-muted/20 p-3">
                    <pre className="text-[11px] font-mono whitespace-pre-wrap text-foreground leading-relaxed">
                      {details.readme}
                    </pre>
                  </div>
                </div>
              )}

              {/* License */}
              {details.license && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    License
                  </span>
                  <p className="text-xs text-foreground">{details.license}</p>
                </div>
              )}

              {/* Config */}
              {details.config && Object.keys(details.config).length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Default Configuration
                  </span>
                  <div className="rounded-md border border-border bg-muted/20 p-3">
                    <pre className="text-[11px] font-mono whitespace-pre-wrap text-foreground">
                      {JSON.stringify(details.config, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Could not load detailed information.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
