import { memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GitFork, TrendingUp, Globe, Users, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SharingLevel = "private" | "team" | "public";

export interface MarketplaceSkillData {
  id: string;
  name: string;
  description: string;
  teamId: string;
  tags: string[];
  version: string;
  author: string;
  usageCount: number;
  sharing: SharingLevel;
  modelPreference: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MarketplaceSkillCardProps {
  skill: MarketplaceSkillData;
  onFork: (skillId: string) => void;
  onSelect: (skill: MarketplaceSkillData) => void;
  isForkPending: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TEAM_BADGE_COLORS: Record<string, string> = {
  planning: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  architecture: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  development: "bg-green-500/15 text-green-600 border-green-500/30",
  testing: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  code_review: "bg-orange-500/15 text-orange-600 border-orange-500/30",
  deployment: "bg-cyan-500/15 text-cyan-600 border-cyan-500/30",
  monitoring: "bg-rose-500/15 text-rose-600 border-rose-500/30",
  fact_check: "bg-violet-500/15 text-violet-600 border-violet-500/30",
};

const SHARING_ICONS: Record<SharingLevel, typeof Globe> = {
  public: Globe,
  team: Users,
  private: Lock,
};

const SHARING_BADGE_STYLES: Record<SharingLevel, string> = {
  public: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
  team: "bg-blue-500/10 text-blue-600 border-blue-500/30",
  private: "bg-muted text-muted-foreground border-border",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatUsageCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

// ─── Component ───────────────────────────────────────────────────────────────

export const MarketplaceSkillCard = memo(function MarketplaceSkillCard({
  skill,
  onFork,
  onSelect,
  isForkPending,
}: MarketplaceSkillCardProps) {
  const teamBadgeClass =
    TEAM_BADGE_COLORS[skill.teamId] ??
    "bg-muted text-muted-foreground border-border";

  const SharingIcon = SHARING_ICONS[skill.sharing];
  const sharingStyle = SHARING_BADGE_STYLES[skill.sharing];

  function handleCardClick() {
    onSelect(skill);
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(skill);
    }
  }

  function handleForkClick(e: React.MouseEvent) {
    e.stopPropagation();
    onFork(skill.id);
  }

  return (
    <Card
      className="flex flex-col border-border shadow-sm bg-card hover:shadow-md transition-shadow cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 outline-none"
      tabIndex={0}
      role="button"
      aria-label={`View details for skill: ${skill.name}`}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-semibold leading-tight truncate">
              {skill.name}
            </CardTitle>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              by {skill.author === "system" ? "system" : skill.author.length > 20 ? skill.author.slice(0, 8) : skill.author} &middot; v{skill.version}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {skill.usageCount > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 border bg-primary/5 text-primary border-primary/20 flex items-center gap-1"
              >
                <TrendingUp className="h-2.5 w-2.5" />
                {formatUsageCount(skill.usageCount)}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1.5 py-0.5 border", teamBadgeClass)}
            >
              {skill.teamId.replace(/_/g, " ")}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0 flex flex-col gap-3 flex-1">
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
          {skill.description || "No description provided."}
        </p>

        {/* Tags */}
        {skill.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {skill.tags.slice(0, 5).map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="text-[10px] px-1.5 py-0.5"
              >
                {tag}
              </Badge>
            ))}
            {skill.tags.length > 5 && (
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0.5 text-muted-foreground"
              >
                +{skill.tags.length - 5}
              </Badge>
            )}
          </div>
        )}

        {/* Footer row */}
        <div className="flex items-center justify-between mt-auto pt-1">
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0.5 border flex items-center gap-1",
              sharingStyle,
            )}
          >
            <SharingIcon className="h-2.5 w-2.5" />
            {skill.sharing}
          </Badge>

          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2 gap-1"
            onClick={handleForkClick}
            disabled={isForkPending}
            aria-label={`Fork skill ${skill.name}`}
          >
            <GitFork className="h-3 w-3" />
            Fork
          </Button>
        </div>
      </CardContent>
    </Card>
  );
});
