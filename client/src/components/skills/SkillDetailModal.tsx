import { useState, useCallback, useEffect } from "react";
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
import {
  GitFork,
  Download,
  Globe,
  Users,
  Lock,
  TrendingUp,
  FileJson,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SkillVersionHistory } from "./SkillVersionHistory";
import type { MarketplaceSkillData, SharingLevel } from "./MarketplaceSkillCard";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillDetailModalProps {
  skill: MarketplaceSkillData | null;
  open: boolean;
  onClose: () => void;
  onFork: (skillId: string) => void;
  onRollback: (skillId: string, version: string) => void;
  isForkPending: boolean;
  isRollbackPending: boolean;
  currentUserId: string | undefined;
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

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function buildSkillConfigForPreview(skill: MarketplaceSkillData): string {
  const config = {
    name: skill.name,
    description: skill.description,
    teamId: skill.teamId,
    version: skill.version,
    author: skill.author,
    tags: skill.tags,
    sharing: skill.sharing,
    modelPreference: skill.modelPreference,
    usageCount: skill.usageCount,
  };
  return JSON.stringify(config, null, 2);
}

// ─── Component ───────────────────────────────────────────────────────────────

export function SkillDetailModal({
  skill,
  open,
  onClose,
  onFork,
  onRollback,
  isForkPending,
  isRollbackPending,
  currentUserId,
}: SkillDetailModalProps) {
  const [activeTab, setActiveTab] = useState<string>("config");

  const isOwner = Boolean(currentUserId && skill?.author === currentUserId);

  // Reset to config tab whenever a different skill is opened
  useEffect(() => {
    if (skill) setActiveTab("config");
  }, [skill?.id]);

  const handleExportJson = useCallback(async () => {
    if (!skill) return;
    try {
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`/api/skills/${skill.id}/export?format=json`, { headers });
      if (!res.ok) throw new Error(`Export failed: ${res.statusText}`);
      const data = await res.json() as Record<string, unknown>;
      triggerDownload(
        JSON.stringify(data, null, 2),
        `${skill.name.replace(/\s+/g, "-").toLowerCase()}.json`,
        "application/json",
      );
    } catch {
      // Fallback: export what we have
      triggerDownload(
        buildSkillConfigForPreview(skill),
        `${skill.name.replace(/\s+/g, "-").toLowerCase()}.json`,
        "application/json",
      );
    }
  }, [skill]);

  const handleExportYaml = useCallback(async () => {
    if (!skill) return;
    try {
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`/api/skills/${skill.id}/export?format=yaml`, { headers });
      if (!res.ok) throw new Error(`Export failed: ${res.statusText}`);
      const yamlText = await res.text();
      triggerDownload(
        yamlText,
        `${skill.name.replace(/\s+/g, "-").toLowerCase()}.yaml`,
        "text/yaml",
      );
    } catch {
      // Fallback: export JSON
      triggerDownload(
        buildSkillConfigForPreview(skill),
        `${skill.name.replace(/\s+/g, "-").toLowerCase()}.json`,
        "application/json",
      );
    }
  }, [skill]);

  function handleRollback(version: string) {
    if (!skill) return;
    onRollback(skill.id, version);
  }

  if (!skill) return null;

  const SharingIcon = SHARING_ICONS[skill.sharing];
  const sharingStyle = SHARING_BADGE_STYLES[skill.sharing];
  const teamBadgeClass =
    TEAM_BADGE_COLORS[skill.teamId] ??
    "bg-muted text-muted-foreground border-border";

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className="max-w-2xl max-h-[80vh] flex flex-col"
        aria-describedby="skill-detail-description"
      >
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold">
                {skill.name}
              </DialogTitle>
              <DialogDescription id="skill-detail-description" className="text-xs mt-1">
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
                sharingStyle,
              )}
            >
              <SharingIcon className="h-2.5 w-2.5" />
              {skill.sharing}
            </Badge>
            {skill.usageCount > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0.5 border bg-primary/5 text-primary border-primary/20 flex items-center gap-1"
              >
                <TrendingUp className="h-2.5 w-2.5" />
                {skill.usageCount} uses
              </Badge>
            )}
            <span className="text-[10px] text-muted-foreground">
              by {skill.author}
            </span>
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
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={() => onFork(skill.id)}
            disabled={isForkPending}
            aria-label={`Fork skill ${skill.name}`}
          >
            <GitFork className="h-3.5 w-3.5" />
            Fork
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={handleExportJson}
            aria-label="Download as JSON"
          >
            <FileJson className="h-3.5 w-3.5" />
            JSON
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1.5"
            onClick={handleExportYaml}
            aria-label="Download as YAML"
          >
            <FileText className="h-3.5 w-3.5" />
            YAML
          </Button>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <TabsList className="shrink-0">
            <TabsTrigger value="config" className="text-xs">Config Preview</TabsTrigger>
            <TabsTrigger value="versions" className="text-xs">Version History</TabsTrigger>
          </TabsList>

          <TabsContent value="config" className="flex-1 overflow-y-auto">
            <div className="rounded-md border border-border bg-muted/20 p-3">
              <pre className="text-[11px] font-mono whitespace-pre-wrap text-foreground">
                {buildSkillConfigForPreview(skill)}
              </pre>
            </div>
          </TabsContent>

          <TabsContent value="versions" className="flex-1 overflow-y-auto">
            <SkillVersionHistory
              skillId={skill.id}
              isOwner={isOwner}
              onRollback={handleRollback}
              isRollbackPending={isRollbackPending}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
