import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2, Lock, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Skill } from "@shared/schema";

interface SkillCardProps {
  skill: Skill;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

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

export function SkillCard({ skill, onView, onEdit, onDelete }: SkillCardProps) {
  const teamBadgeClass =
    TEAM_BADGE_COLORS[skill.teamId] ??
    "bg-muted text-muted-foreground border-border";

  return (
    <Card
      className="flex flex-col border-border shadow-sm bg-card hover:shadow-md transition-shadow cursor-pointer"
      onClick={onView}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onView();
        }
      }}
      aria-label={`View skill: ${skill.name}`}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-semibold leading-tight truncate">
              {skill.name}
            </CardTitle>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {skill.isBuiltin && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 bg-muted/50 text-muted-foreground border-border flex items-center gap-1"
              >
                <Lock className="h-2.5 w-2.5" />
                Built-in
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
        {skill.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {skill.description}
          </p>
        )}

        {/* Usage count */}
        {skill.usageCount > 0 && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <TrendingUp className="h-3 w-3" />
            <span>{skill.usageCount} use{skill.usageCount !== 1 ? "s" : ""}</span>
          </div>
        )}

        {/* Tags */}
        {skill.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(skill.tags as string[]).map((tag) => (
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

        {/* Footer row */}
        <div className="flex items-center justify-between mt-auto pt-1">
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0.5 border",
              skill.isPublic
                ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30"
                : "bg-muted text-muted-foreground border-border",
            )}
          >
            {skill.isPublic ? "Public" : "Private"}
          </Badge>

          {!skill.isBuiltin && (
            <div
              className="flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                title="Edit skill"
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-destructive hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                title="Delete skill"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
