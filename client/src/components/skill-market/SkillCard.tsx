import { memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, TrendingUp, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillCardProps {
  name: string;
  description: string;
  source: string;
  sourceIcon?: string;
  tags: string[];
  popularity?: number;
  installable: boolean;
  installed?: boolean;
  onInstall: () => void;
  onSelect?: () => void;
  isInstallPending?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  "mcp-registry": "bg-blue-500/15 text-blue-600 border-blue-500/30",
  composio: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  "crewai-github": "bg-green-500/15 text-green-600 border-green-500/30",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPopularity(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

// ─── Component ───────────────────────────────────────────────────────────────

export const SkillMarketCard = memo(function SkillMarketCard({
  name,
  description,
  source,
  sourceIcon,
  tags,
  popularity,
  installable,
  installed,
  onInstall,
  onSelect,
  isInstallPending,
}: SkillCardProps) {
  const sourceBadgeClass =
    SOURCE_COLORS[source] ?? "bg-muted text-muted-foreground border-border";

  function handleCardClick() {
    onSelect?.();
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect?.();
    }
  }

  function handleInstallClick(e: React.MouseEvent) {
    e.stopPropagation();
    onInstall();
  }

  return (
    <Card
      className={cn(
        "flex flex-col border-border shadow-sm bg-card transition-shadow",
        onSelect && "hover:shadow-md cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 outline-none",
      )}
      tabIndex={onSelect ? 0 : undefined}
      role={onSelect ? "button" : undefined}
      aria-label={onSelect ? `View details for ${name}` : undefined}
      onClick={onSelect ? handleCardClick : undefined}
      onKeyDown={onSelect ? handleCardKeyDown : undefined}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-semibold leading-tight truncate">
              {name}
            </CardTitle>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {popularity != null && popularity > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 border bg-primary/5 text-primary border-primary/20 flex items-center gap-1"
              >
                <TrendingUp className="h-2.5 w-2.5" />
                {formatPopularity(popularity)}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1.5 py-0.5 border flex items-center gap-1", sourceBadgeClass)}
            >
              {sourceIcon && (
                <img
                  src={sourceIcon}
                  alt=""
                  className="h-3 w-3 rounded-sm"
                  aria-hidden="true"
                />
              )}
              {source}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0 flex flex-col gap-3 flex-1">
        {description && (
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {description}
          </p>
        )}

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.slice(0, 5).map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="text-[10px] px-1.5 py-0.5"
              >
                {tag}
              </Badge>
            ))}
            {tags.length > 5 && (
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0.5 text-muted-foreground"
              >
                +{tags.length - 5}
              </Badge>
            )}
          </div>
        )}

        {/* Footer row */}
        <div className="flex items-center justify-end mt-auto pt-1">
          {installed ? (
            <Badge
              variant="outline"
              className="text-[10px] px-2 py-0.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 flex items-center gap-1"
            >
              <Check className="h-2.5 w-2.5" />
              Installed
            </Badge>
          ) : installable ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px] px-2 gap-1"
              onClick={handleInstallClick}
              disabled={isInstallPending}
              aria-label={`Install ${name}`}
            >
              <Download className="h-3 w-3" />
              {isInstallPending ? "Installing..." : "Install"}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
});
