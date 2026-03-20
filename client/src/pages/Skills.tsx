import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, Upload, Download, Plus, Users, Cpu } from "lucide-react";
import { ModelSkillsTab } from "@/components/skills/ModelSkillsTab";
import { cn } from "@/lib/utils";
import { SDLC_TEAMS } from "@shared/constants";
import {
  useSkills,
  useDeleteSkill,
  useExportSkills,
  useImportSkills,
} from "@/hooks/use-skills";
import { useSkillTeams, useCreateSkillTeam } from "@/hooks/use-skill-teams";
import { SkillCard } from "@/components/skills/SkillCard";
import { SkillEditor } from "@/components/skills/SkillEditor";
import { SkillLibraryDetailModal } from "@/components/skills/SkillLibraryDetailModal";
import type { Skill } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { GitSourcesSection } from "@/components/skills/GitSourcesSection";

type SkillFilter = "all" | "builtin" | "custom";

function parseImportFile(file: File): Promise<{ skills: Partial<Skill>[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target?.result as string) as unknown;
        // Support both bare array and { skills: [...] } format
        if (Array.isArray(parsed)) {
          resolve({ skills: parsed as Partial<Skill>[] });
        } else if (
          parsed !== null &&
          typeof parsed === "object" &&
          "skills" in parsed &&
          Array.isArray((parsed as { skills: unknown }).skills)
        ) {
          resolve({ skills: (parsed as { skills: Partial<Skill>[] }).skills });
        } else {
          reject(new Error("Invalid import file format"));
        }
      } catch {
        reject(new Error("Failed to parse JSON file"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

// ─── Create Team Dialog ───────────────────────────────────────────────────────

interface CreateTeamDialogProps {
  open: boolean;
  onClose: () => void;
}

function CreateTeamDialog({ open, onClose }: CreateTeamDialogProps) {
  const { toast } = useToast();
  const createTeam = useCreateSkillTeam();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();

  function handleClose() {
    setName("");
    setDescription("");
    setNameError(undefined);
    onClose();
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError("Name is required.");
      return;
    }
    if (trimmedName.length > 100) {
      setNameError("Name must be 100 characters or less.");
      return;
    }
    try {
      await createTeam.mutateAsync({ name: trimmedName, description: description.trim() });
      toast({ title: "Team created" });
      handleClose();
    } catch (err) {
      toast({
        title: "Failed to create team",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">New Custom Team</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="team-name" className="text-xs font-medium">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="team-name"
              className="h-8 text-sm"
              placeholder="e.g. Infrastructure"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(undefined);
              }}
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="team-description" className="text-xs font-medium">
              Description
            </Label>
            <Textarea
              id="team-description"
              className="text-sm min-h-[60px] resize-y"
              placeholder="What is this team for?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={createTeam.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={createTeam.isPending}>
            {createTeam.isPending ? "Creating..." : "Create Team"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Skills() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"library" | "model-skills">("library");
  const { data: skills = [], isLoading, error } = useSkills();
  const { data: customTeams = [] } = useSkillTeams();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const deleteSkill = useDeleteSkill();
  const exportSkills = useExportSkills();
  const importSkills = useImportSkills();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<SkillFilter>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | undefined>(undefined);

  const [viewingSkill, setViewingSkill] = useState<Skill | undefined>(undefined);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);

  // Derive unique tags across all skills
  const allTags = Array.from(
    new Set(skills.flatMap((s) => s.tags as string[])),
  ).sort();

  // Build a team name lookup that includes custom teams
  const customTeamNames: Record<string, string> = {};
  for (const t of customTeams) {
    customTeamNames[t.id] = t.name;
  }

  // Filter skills
  const filtered = skills.filter((s) => {
    if (typeFilter === "builtin" && !s.isBuiltin) return false;
    if (typeFilter === "custom" && s.isBuiltin) return false;
    if (teamFilter !== "all" && s.teamId !== teamFilter) return false;
    if (tagFilter !== "all" && !(s.tags as string[]).includes(tagFilter))
      return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (
        !s.name.toLowerCase().includes(q) &&
        !s.description.toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  function handleCreate() {
    setEditingSkill(undefined);
    setEditorOpen(true);
  }

  function handleEdit(skill: Skill) {
    setEditingSkill(skill);
    setEditorOpen(true);
  }

  async function handleDelete(skill: Skill) {
    if (!confirm(`Delete skill "${skill.name}"?`)) return;
    try {
      await deleteSkill.mutateAsync(skill.id);
      toast({ title: "Skill deleted" });
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function handleExport() {
    try {
      await exportSkills.mutateAsync();
      toast({ title: "Skills exported" });
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so the same file can be re-selected
    e.target.value = "";

    try {
      const parsed = await parseImportFile(file);
      const result = await importSkills.mutateAsync({
        skills: parsed.skills as Parameters<typeof importSkills.mutateAsync>[0]["skills"],
        conflictStrategy: "skip",
      });
      toast({
        title: "Import complete",
        description: `Imported ${result.imported}, skipped ${result.skipped}${result.errors.length > 0 ? `, ${result.errors.length} error(s)` : ""}.`,
      });
    } catch (err) {
      toast({
        title: "Import failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  const builtinTeamEntries = Object.entries(SDLC_TEAMS);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Skills Library</h1>
          {!isLoading && (
            <span className="text-xs text-muted-foreground">
              ({skills.length} skill{skills.length !== 1 ? "s" : ""})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleExport}
            disabled={exportSkills.isPending}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Export All
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={importSkills.isPending}
            className="gap-1.5"
          >
            <Upload className="h-3.5 w-3.5" />
            Import
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateTeamOpen(true)}
            className="gap-1.5"
          >
            <Users className="h-3.5 w-3.5" />
            New Team
          </Button>
          <Button size="sm" onClick={handleCreate} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Create Skill
          </Button>
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex items-center gap-1 px-6 py-0 border-b border-border shrink-0">
        <button
          type="button"
          onClick={() => setActiveTab("library")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "library"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Library
          </span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("model-skills")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "model-skills"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="flex items-center gap-1.5">
            <Cpu className="h-3.5 w-3.5" />
            Model Skills
          </span>
        </button>
      </div>

      {activeTab === "model-skills" ? (
        <ModelSkillsTab />
      ) : (
      <>
      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0 flex-wrap">
        {/* Search */}
        <Input
          className="h-8 text-sm w-56"
          placeholder="Search name or description..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {/* Type filter */}
        <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
          {(["all", "builtin", "custom"] as SkillFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setTypeFilter(f)}
              className={cn(
                "px-3 py-1.5 capitalize transition-colors",
                typeFilter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Team filter */}
        <Select value={teamFilter} onValueChange={setTeamFilter}>
          <SelectTrigger className="h-8 text-xs w-40">
            <SelectValue placeholder="All teams" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All teams</SelectItem>
            <SelectGroup>
              <SelectLabel className="text-[10px]">Built-in</SelectLabel>
              {builtinTeamEntries.map(([id, config]) => (
                <SelectItem key={id} value={id}>
                  {config.name}
                </SelectItem>
              ))}
            </SelectGroup>
            {customTeams.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Custom</SelectLabel>
                  {customTeams.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
          </SelectContent>
        </Select>

        {/* Tag filter */}
        {allTags.length > 0 && (
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="h-8 text-xs w-36">
              <SelectValue placeholder="All tags" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              {allTags.map((tag) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(search || teamFilter !== "all" || typeFilter !== "all" || tagFilter !== "all") && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setTeamFilter("all");
              setTypeFilter("all");
              setTagFilter("all");
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-destructive">Failed to load skills.</p>
            <p className="text-xs text-muted-foreground mt-1">
              {error instanceof Error ? error.message : "Unknown error"}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">
              {skills.length === 0
                ? "No skills yet. Create your first skill to get started."
                : "No skills match the current filters."}
            </p>
            {skills.length === 0 && (
              <Button size="sm" onClick={handleCreate} className="mt-4 gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                Create Skill
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onView={() => setViewingSkill(skill)}
                onEdit={() => handleEdit(skill)}
                onDelete={() => handleDelete(skill)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Git Sources Section */}
      <div className="px-6 pb-4">
        <GitSourcesSection isAdmin={isAdmin} />
      </div>

      </>
      )}

      {activeTab === "library" && (
      <>
      {/* Skill Detail Modal (view only) */}
      <SkillLibraryDetailModal
        skill={viewingSkill ?? null}
        open={Boolean(viewingSkill)}
        onClose={() => setViewingSkill(undefined)}
        onEdit={() => {
          if (viewingSkill) {
            setViewingSkill(undefined);
            handleEdit(viewingSkill);
          }
        }}
      />

      {/* Skill Editor Modal */}
      <SkillEditor
        skill={editingSkill}
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        onSaved={() => {
          setEditorOpen(false);
          toast({
            title: editingSkill ? "Skill updated" : "Skill created",
          });
        }}
      />

      {/* Create Team Dialog */}
      <CreateTeamDialog
        open={createTeamOpen}
        onClose={() => setCreateTeamOpen(false)}
      />
      </>
      )}
    </div>
  );
}
