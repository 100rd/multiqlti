import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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
import { cn } from "@/lib/utils";
import { Plus, Loader2 } from "lucide-react";
import { SDLC_TEAMS } from "@shared/constants";
import { useCreateSkill, useUpdateSkill, type CreateSkillPayload } from "@/hooks/use-skills";
import { useSkillTeams, useCreateSkillTeam } from "@/hooks/use-skill-teams";
import type { Skill } from "@shared/schema";

const AVAILABLE_TOOLS = [
  "knowledge_search",
  "web_search",
  "code_execution",
  "code_search",
  "file_read",
  "file_write",
] as const;

type AvailableTool = (typeof AVAILABLE_TOOLS)[number];

interface SkillEditorProps {
  skill?: Skill;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  description: string;
  teamId: string;
  systemPromptOverride: string;
  tools: AvailableTool[];
  modelPreference: string;
  tags: string;
  isPublic: boolean;
}

function buildInitialForm(skill?: Skill): FormState {
  if (!skill) {
    return {
      name: "",
      description: "",
      teamId: "",
      systemPromptOverride: "",
      tools: [],
      modelPreference: "",
      tags: "",
      isPublic: true,
    };
  }
  return {
    name: skill.name,
    description: skill.description,
    teamId: skill.teamId,
    systemPromptOverride: skill.systemPromptOverride,
    tools: ((skill.tools as string[]) ?? []).filter((t): t is AvailableTool =>
      (AVAILABLE_TOOLS as readonly string[]).includes(t),
    ),
    modelPreference: skill.modelPreference ?? "",
    tags: ((skill.tags as string[]) ?? []).join(", "),
    isPublic: skill.isPublic,
  };
}

interface FormErrors {
  name?: string;
  teamId?: string;
}

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = "Name is required.";
  if (!form.teamId) errors.teamId = "Team is required.";
  return errors;
}

export function SkillEditor({ skill, open, onClose, onSaved }: SkillEditorProps) {
  const isEditing = Boolean(skill);
  const [form, setForm] = useState<FormState>(() => buildInitialForm(skill));
  const [errors, setErrors] = useState<FormErrors>({});

  // Inline new-team creation state
  const [showNewTeam, setShowNewTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamError, setNewTeamError] = useState<string | undefined>();

  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const { data: customTeams = [] } = useSkillTeams();
  const createTeam = useCreateSkillTeam();

  const isPending = createSkill.isPending || updateSkill.isPending;

  // Reset form when skill changes or dialog opens
  useEffect(() => {
    if (open) {
      setForm(buildInitialForm(skill));
      setErrors({});
      setShowNewTeam(false);
      setNewTeamName("");
      setNewTeamError(undefined);
    }
  }, [open, skill]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [key]: undefined }));
    }
  }

  function toggleTool(tool: AvailableTool) {
    setForm((prev) => ({
      ...prev,
      tools: prev.tools.includes(tool)
        ? prev.tools.filter((t) => t !== tool)
        : [...prev.tools, tool],
    }));
  }

  async function handleCreateTeam() {
    const trimmed = newTeamName.trim();
    if (!trimmed) {
      setNewTeamError("Team name is required.");
      return;
    }
    if (trimmed.length > 100) {
      setNewTeamError("Team name must be 100 characters or less.");
      return;
    }
    try {
      const created = await createTeam.mutateAsync({ name: trimmed });
      setField("teamId", created.id);
      setShowNewTeam(false);
      setNewTeamName("");
      setNewTeamError(undefined);
    } catch (err) {
      setNewTeamError(err instanceof Error ? err.message : "Failed to create team.");
    }
  }

  async function handleSave() {
    const validationErrors = validate(form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    const parsedTags = form.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const payload: CreateSkillPayload = {
      name: form.name.trim(),
      description: form.description.trim(),
      teamId: form.teamId,
      systemPromptOverride: form.systemPromptOverride.trim(),
      tools: form.tools,
      modelPreference: form.modelPreference.trim() || null,
      outputSchema: null,
      tags: parsedTags,
      isPublic: form.isPublic,
    };

    if (isEditing && skill) {
      await updateSkill.mutateAsync({ id: skill.id, ...payload });
    } else {
      await createSkill.mutateAsync(payload);
    }

    onSaved();
    onClose();
  }

  const builtinTeamEntries = Object.entries(SDLC_TEAMS);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {isEditing ? "Edit Skill" : "Create Skill"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name */}
          <div className="space-y-1">
            <Label htmlFor="skill-name" className="text-xs font-medium">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="skill-name"
              className="h-8 text-sm"
              placeholder="e.g. API Designer"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name}</p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-1">
            <Label htmlFor="skill-description" className="text-xs font-medium">
              Description
            </Label>
            <Textarea
              id="skill-description"
              className="text-sm min-h-[60px] resize-y"
              placeholder="What does this skill do?"
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
            />
          </div>

          {/* Team */}
          <div className="space-y-1">
            <Label className="text-xs font-medium">
              Team <span className="text-destructive">*</span>
            </Label>
            {!showNewTeam ? (
              <Select value={form.teamId} onValueChange={(v) => {
                if (v === "__new__") {
                  setShowNewTeam(true);
                } else {
                  setField("teamId", v);
                }
              }}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Select a team" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel className="text-[10px]">Built-in Teams</SelectLabel>
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
                        <SelectLabel className="text-[10px]">Custom Teams</SelectLabel>
                        {customTeams.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </>
                  )}
                  <SelectSeparator />
                  <SelectItem value="__new__" className="text-primary">
                    <div className="flex items-center gap-1.5">
                      <Plus className="h-3 w-3" />
                      New team
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <div className="space-y-2 rounded-md border border-border p-2 bg-muted/30">
                <p className="text-[10px] text-muted-foreground font-medium">New custom team</p>
                <div className="flex gap-2">
                  <Input
                    className="h-7 text-xs flex-1"
                    placeholder="Team name..."
                    value={newTeamName}
                    onChange={(e) => {
                      setNewTeamName(e.target.value);
                      setNewTeamError(undefined);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleCreateTeam();
                      }
                      if (e.key === "Escape") {
                        setShowNewTeam(false);
                        setNewTeamName("");
                      }
                    }}
                    autoFocus
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => void handleCreateTeam()}
                    disabled={createTeam.isPending}
                  >
                    {createTeam.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Create"
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs px-2"
                    onClick={() => {
                      setShowNewTeam(false);
                      setNewTeamName("");
                      setNewTeamError(undefined);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                {newTeamError && (
                  <p className="text-xs text-destructive">{newTeamError}</p>
                )}
              </div>
            )}
            {errors.teamId && (
              <p className="text-xs text-destructive">{errors.teamId}</p>
            )}
          </div>

          {/* System Prompt */}
          <div className="space-y-1">
            <Label htmlFor="skill-prompt" className="text-xs font-medium">
              System Prompt Override
            </Label>
            <Textarea
              id="skill-prompt"
              className="text-xs font-mono min-h-[100px] resize-y"
              placeholder="Override the stage's system prompt when this skill is applied..."
              value={form.systemPromptOverride}
              onChange={(e) => setField("systemPromptOverride", e.target.value)}
            />
          </div>

          {/* Tools */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Tools</Label>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_TOOLS.map((tool) => {
                const selected = form.tools.includes(tool);
                return (
                  <button
                    key={tool}
                    type="button"
                    onClick={() => toggleTool(tool)}
                    className={cn(
                      "text-[11px] font-mono px-2 py-1 rounded border transition-colors",
                      selected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary/50",
                    )}
                  >
                    {tool}
                  </button>
                );
              })}
            </div>
            {form.tools.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {form.tools.map((t) => (
                  <Badge key={t} variant="secondary" className="text-[10px]">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Model Preference */}
          <div className="space-y-1">
            <Label htmlFor="skill-model" className="text-xs font-medium">
              Model Preference
            </Label>
            <Input
              id="skill-model"
              className="h-8 text-sm font-mono"
              placeholder="Use stage default"
              value={form.modelPreference}
              onChange={(e) => setField("modelPreference", e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">
              Leave empty to use the stage's configured model.
            </p>
          </div>

          {/* Tags */}
          <div className="space-y-1">
            <Label htmlFor="skill-tags" className="text-xs font-medium">
              Tags
            </Label>
            <Input
              id="skill-tags"
              className="h-8 text-sm"
              placeholder="api, design, openapi (comma-separated)"
              value={form.tags}
              onChange={(e) => setField("tags", e.target.value)}
            />
          </div>

          {/* Public toggle */}
          <div className="flex items-center justify-between py-1">
            <div>
              <Label className="text-xs font-medium">Public</Label>
              <p className="text-[10px] text-muted-foreground">
                Public skills are visible to all users in this workspace.
              </p>
            </div>
            <Switch
              checked={form.isPublic}
              onCheckedChange={(v) => setField("isPublic", v)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving..." : isEditing ? "Save Changes" : "Create Skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
