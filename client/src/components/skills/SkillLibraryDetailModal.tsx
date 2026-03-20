import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Lock, TrendingUp, Globe, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { SkillVersionHistory } from "./SkillVersionHistory";
import type { Skill } from "@shared/schema";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillLibraryDetailModalProps {
  skill: Skill | null;
  open: boolean;
  onClose: () => void;
  onEdit: () => void;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function noopRollback(_version: string): void {
  // Version rollback not available in the library detail view
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SkillLibraryDetailModal({
  skill,
  open,
  onClose,
  onEdit,
}: SkillLibraryDetailModalProps) {
  const [activeTab, setActiveTab] = useState<string>("details");

  // Reset tab when a different skill is opened
  useEffect(() => {
    if (skill) setActiveTab("details");
  }, [skill?.id]);

  if (!skill) return null;

  const teamBadgeClass =
    TEAM_BADGE_COLORS[skill.teamId] ?? "bg-muted text-muted-foreground border-border";

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className="max-w-2xl max-h-[80vh] flex flex-col"
        aria-describedby="skill-library-detail-description"
      >
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold">
                {skill.name}
              </DialogTitle>
              <DialogDescription
                id="skill-library-detail-description"
                className="text-xs mt-1 text-muted-foreground"
              >
                {skill.description || "No description available."}
              </DialogDescription>
            </div>
          </div>

          {/* Metadata badges */}
          <div className="flex items-center gap-2 flex-wrap pt-2">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 font-mono">
              v{skill.version}
            </Badge>
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1.5 py-0.5 border", teamBadgeClass)}
            >
              {skill.teamId.replace(/_/g, " ")}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] px-1.5 py-0.5 border flex items-center gap-1",
                skill.isPublic
                  ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30"
                  : "bg-muted text-muted-foreground border-border",
              )}
            >
              <Globe className="h-2.5 w-2.5" />
              {skill.isPublic ? "Public" : "Private"}
            </Badge>
            {skill.isBuiltin && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 bg-muted/50 text-muted-foreground border-border flex items-center gap-1"
              >
                <Lock className="h-2.5 w-2.5" />
                Built-in
              </Badge>
            )}
            {skill.usageCount > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 border bg-primary/5 text-primary border-primary/20 flex items-center gap-1"
              >
                <TrendingUp className="h-2.5 w-2.5" />
                {skill.usageCount} use{skill.usageCount !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>

          {/* Tags */}
          {(skill.tags as string[]).length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {(skill.tags as string[]).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0.5">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </DialogHeader>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 flex flex-col min-h-0"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="details" className="text-xs">Details</TabsTrigger>
            <TabsTrigger value="history" className="text-xs">Version History</TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="flex-1 overflow-y-auto space-y-3">
            {/* System Prompt */}
            {skill.systemPromptOverride && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  System Prompt Override
                </p>
                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <pre className="text-[11px] font-mono whitespace-pre-wrap text-foreground">
                    {skill.systemPromptOverride}
                  </pre>
                </div>
              </div>
            )}

            {/* Tools */}
            {(skill.tools as string[]).length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Tools
                </p>
                <div className="flex flex-wrap gap-1">
                  {(skill.tools as string[]).map((tool) => (
                    <Badge key={tool} variant="secondary" className="text-[10px] font-mono px-1.5 py-0.5">
                      {tool}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Model Preference */}
            {skill.modelPreference && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                  Model Preference
                </p>
                <p className="text-xs font-mono text-foreground">{skill.modelPreference}</p>
              </div>
            )}

            {/* Empty state */}
            {!skill.systemPromptOverride &&
              (skill.tools as string[]).length === 0 &&
              !skill.modelPreference && (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No additional configuration for this skill.
                </p>
              )}
          </TabsContent>

          <TabsContent value="history" className="flex-1 overflow-y-auto">
            {skill.id ? (
              <SkillVersionHistory
                skillId={skill.id}
                isOwner={false}
                onRollback={noopRollback}
                isRollbackPending={false}
              />
            ) : null}
          </TabsContent>
        </Tabs>

        {/* Action buttons */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          {!skill.isBuiltin && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1.5"
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
