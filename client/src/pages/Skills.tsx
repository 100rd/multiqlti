import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sparkles, Upload, Download, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { SDLC_TEAMS } from "@shared/constants";
import {
  useSkills,
  useDeleteSkill,
  useExportSkills,
  useImportSkills,
} from "@/hooks/use-skills";
import { SkillCard } from "@/components/skills/SkillCard";
import { SkillEditor } from "@/components/skills/SkillEditor";
import type { Skill } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

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

export default function Skills() {
  const { toast } = useToast();
  const { data: skills = [], isLoading, error } = useSkills();
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

  // Derive unique tags across all skills
  const allTags = Array.from(
    new Set(skills.flatMap((s) => s.tags as string[])),
  ).sort();

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

  const teamEntries = Object.entries(SDLC_TEAMS);

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
          <Button size="sm" onClick={handleCreate} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Create Skill
          </Button>
        </div>
      </div>

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
            {teamEntries.map(([id, config]) => (
              <SelectItem key={id} value={id}>
                {config.name}
              </SelectItem>
            ))}
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
                onEdit={() => handleEdit(skill)}
                onDelete={() => handleDelete(skill)}
              />
            ))}
          </div>
        )}
      </div>

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
    </div>
  );
}
