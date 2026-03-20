import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { Cpu, Plus, Trash2, X } from "lucide-react";
import { DEFAULT_MODELS } from "@shared/constants";
import { useSkills } from "@/hooks/use-skills";
import {
  useModelSkills,
  useModelsWithSkills,
  useBindSkillToModel,
  useUnbindSkillFromModel,
} from "@/hooks/use-model-skill-bindings";
import { useToast } from "@/hooks/use-toast";
import type { Skill } from "@shared/schema";

// ─── Known models catalogue ───────────────────────────────────────────────────

interface KnownModel {
  id: string;
  label: string;
  provider: string;
}

const CATALOGUE: KnownModel[] = DEFAULT_MODELS.map((m) => ({
  id: "modelId" in m && m.modelId ? (m.modelId as string) : m.slug,
  label: m.name,
  provider: m.provider,
}));

const CATALOGUE_BY_PROVIDER: Record<string, KnownModel[]> = {};
for (const model of CATALOGUE) {
  (CATALOGUE_BY_PROVIDER[model.provider] ??= []).push(model);
}
const PROVIDER_ORDER = ["anthropic", "google", "xai", "mock"] as const;

// ─── Add-Skill Dialog ─────────────────────────────────────────────────────────

interface AddSkillDialogProps {
  modelId: string;
  boundSkillIds: Set<string>;
  open: boolean;
  onClose: () => void;
}

function AddSkillDialog({ modelId, boundSkillIds, open, onClose }: AddSkillDialogProps) {
  const { toast } = useToast();
  const { data: allSkills = [] } = useSkills();
  const bind = useBindSkillToModel();
  const [selectedSkillId, setSelectedSkillId] = useState("");

  const available = allSkills.filter((s) => !boundSkillIds.has(s.id));

  function handleClose() {
    setSelectedSkillId("");
    onClose();
  }

  async function handleAdd() {
    if (!selectedSkillId) return;
    try {
      await bind.mutateAsync({ modelId, skillId: selectedSkillId });
      toast({ title: "Skill bound to model" });
      handleClose();
    } catch (err) {
      toast({
        title: "Failed to bind skill",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Add Skill to Model</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <p className="text-xs text-muted-foreground mb-3">
            Select a skill to bind to <span className="font-mono font-medium text-foreground">{modelId}</span>.
          </p>
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              All available skills are already bound.
            </p>
          ) : (
            <Select value={selectedSkillId} onValueChange={setSelectedSkillId}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Select a skill..." />
              </SelectTrigger>
              <SelectContent>
                {available.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span>{s.name}</span>
                    {s.teamId && (
                      <span className="ml-2 text-xs text-muted-foreground">({s.teamId})</span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={bind.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={!selectedSkillId || bind.isPending || available.length === 0}
          >
            {bind.isPending ? "Binding..." : "Add Skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Model Skill Row ──────────────────────────────────────────────────────────

interface ModelSkillRowProps {
  skill: Skill;
  modelId: string;
}

function ModelSkillRow({ skill, modelId }: ModelSkillRowProps) {
  const { toast } = useToast();
  const unbind = useUnbindSkillFromModel();

  async function handleUnbind() {
    if (!confirm(`Remove skill "${skill.name}" from this model?`)) return;
    try {
      await unbind.mutateAsync({ modelId, skillId: skill.id });
      toast({ title: "Skill unbound" });
    } catch (err) {
      toast({
        title: "Failed to unbind skill",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-md border border-border bg-card hover:bg-muted/30 transition-colors">
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{skill.name}</p>
        {skill.description && (
          <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
        )}
        <div className="flex flex-wrap gap-1 mt-1">
          {(skill.tags as string[]).slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
              {tag}
            </Badge>
          ))}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0 ml-2"
        onClick={handleUnbind}
        disabled={unbind.isPending}
        aria-label="Unbind skill"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ─── Model Panel ──────────────────────────────────────────────────────────────

interface ModelPanelProps {
  modelId: string;
  label: string;
}

function ModelPanel({ modelId, label }: ModelPanelProps) {
  const { data: boundSkills = [], isLoading } = useModelSkills(modelId);
  const [addOpen, setAddOpen] = useState(false);
  const boundSkillIds = new Set(boundSkills.map((s) => s.id));

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div>
          <p className="text-sm font-semibold">{label}</p>
          <p className="text-xs font-mono text-muted-foreground">{modelId}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {boundSkills.length} skill{boundSkills.length !== 1 ? "s" : ""}
          </span>
          <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={() => setAddOpen(true)}>
            <Plus className="h-3 w-3" />
            Add
          </Button>
        </div>
      </div>

      <div className="p-3 space-y-2">
        {isLoading ? (
          <>
            <Skeleton className="h-12 rounded-md" />
            <Skeleton className="h-12 rounded-md" />
          </>
        ) : boundSkills.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No skills bound to this model yet.
          </p>
        ) : (
          boundSkills.map((skill) => (
            <ModelSkillRow key={skill.id} skill={skill} modelId={modelId} />
          ))
        )}
      </div>

      <AddSkillDialog
        modelId={modelId}
        boundSkillIds={boundSkillIds}
        open={addOpen}
        onClose={() => setAddOpen(false)}
      />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ModelSkillsTab() {
  const { data: activeModelIds = [], isLoading: loadingActive } = useModelsWithSkills();
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [newModelId, setNewModelId] = useState("");

  // Derive which models are "shown" — union of models with bindings + manually added
  const [manuallyAdded, setManuallyAdded] = useState<string[]>([]);
  const shownModelIds = Array.from(new Set([...activeModelIds, ...manuallyAdded])).sort();

  function modelLabel(modelId: string): string {
    const found = CATALOGUE.find((m) => m.id === modelId);
    return found ? found.label : modelId;
  }

  function handleAddModel() {
    const id = selectedModelId || newModelId.trim();
    if (!id) return;
    if (!shownModelIds.includes(id)) {
      setManuallyAdded((prev) => [...prev, id]);
    }
    setSelectedModelId("");
    setNewModelId("");
    setAddModelOpen(false);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Model-Specific Skills</span>
          <span className="text-xs text-muted-foreground">
            Bind skills to run automatically for a given LLM model
          </span>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs" onClick={() => setAddModelOpen(true)}>
          <Plus className="h-3 w-3" />
          Add Model
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loadingActive ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-lg" />
            ))}
          </div>
        ) : shownModelIds.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Cpu className="h-8 w-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">No model skill bindings yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Add a model to start assigning skills to it.
            </p>
            <Button size="sm" className="mt-4 gap-1.5" onClick={() => setAddModelOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add Model
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {shownModelIds.map((modelId) => (
              <ModelPanel key={modelId} modelId={modelId} label={modelLabel(modelId)} />
            ))}
          </div>
        )}
      </div>

      {/* Add Model Dialog */}
      <Dialog open={addModelOpen} onOpenChange={(o) => { if (!o) { setAddModelOpen(false); setSelectedModelId(""); setNewModelId(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Add Model</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-2">Select a known model:</p>
              <Select value={selectedModelId} onValueChange={(v) => { setSelectedModelId(v); setNewModelId(""); }}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Choose a model..." />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_ORDER.map((provider) => {
                    const models = CATALOGUE_BY_PROVIDER[provider];
                    if (!models?.length) return null;
                    return (
                      <SelectGroup key={provider}>
                        <SelectLabel className="text-[10px] uppercase">{provider}</SelectLabel>
                        {models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setAddModelOpen(false); setSelectedModelId(""); setNewModelId(""); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleAddModel} disabled={!selectedModelId && !newModelId.trim()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
