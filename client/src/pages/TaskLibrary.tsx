/**
 * Task Library (FE3): list / create / edit / delete standalone, reusable task
 * templates (single-task recipes + organizational labels). The list is
 * owner-scoped server-side; an admin additionally sees an Owner column (mirrors
 * the Activity history admin rule — `createdBy` is only present for admins, so
 * its presence drives the column). Templates compose into groups via copy-in
 * (the composer's "Add from library"); editing/deleting one here never mutates a
 * past iteration's history (copy-in snapshot).
 *
 * SECURITY: every template field is user-authored and rendered as INERT React
 * text (value/children) — never via dangerouslySetInnerHTML. The label query is
 * server-validated + parameterized.
 */
import { useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useActiveModels } from "@/hooks/use-pipeline";
import {
  useTaskTemplates,
  useCreateTaskTemplate,
  useUpdateTaskTemplate,
  useDeleteTaskTemplate,
  type TaskTemplate,
  type TaskTemplateInput,
} from "@/hooks/use-task-templates";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Library, Loader2, X } from "lucide-react";
import { LabelChipEditor } from "@/components/task-groups/label-chip-editor";
import {
  DEFAULT_MODEL_OPTION,
  setTaskModel,
  type ModelOption,
} from "@/components/task-groups/task-form";

type ExecutionMode = "direct_llm" | "pipeline_run";

interface TemplateDraft {
  name: string;
  description: string;
  executionMode: ExecutionMode;
  modelSlug: string | null;
  labels: string[];
}

function emptyDraft(): TemplateDraft {
  return {
    name: "",
    description: "",
    executionMode: "direct_llm",
    modelSlug: null,
    labels: [],
  };
}

function draftFromTemplate(t: TaskTemplate): TemplateDraft {
  return {
    name: t.name,
    description: t.description,
    executionMode: t.executionMode === "pipeline_run" ? "pipeline_run" : "direct_llm",
    modelSlug: t.modelSlug,
    labels: t.labels ?? [],
  };
}

function toPayload(draft: TemplateDraft): TaskTemplateInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    executionMode: draft.executionMode,
    labels: draft.labels,
    // Omit a pinned model when unset so the server applies its real default
    // (never "mock"); an explicit null clears any prior pin on update.
    modelSlug: draft.modelSlug,
  };
}

/** Apply the shared null-or-slug model rule (reuses setTaskModel via a stub row). */
function resolveModelSlug(value: string): string | null {
  return setTaskModel(
    {
      id: "",
      name: "",
      description: "",
      executionMode: "direct_llm",
      dependsOn: [],
      modelSlug: null,
      labels: [],
      templateId: null,
    },
    value,
  ).modelSlug;
}

// ─── Editor (create + edit share this) ───────────────────────────────────────

interface TemplateEditorProps {
  initial: TemplateDraft;
  models: readonly ModelOption[];
  pending: boolean;
  submitLabel: string;
  onSubmit: (draft: TemplateDraft) => void;
  onCancel: () => void;
}

function TemplateEditor({
  initial,
  models,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: TemplateEditorProps) {
  const [draft, setDraft] = useState<TemplateDraft>(initial);
  const [submitted, setSubmitted] = useState(false);

  const nameError = !draft.name.trim() ? "Name is required." : null;
  const descError = !draft.description.trim() ? "Description is required." : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (nameError || descError) return;
    onSubmit(draft);
  }

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-base">{submitLabel} template</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="tpl-name">Name *</Label>
            <Input
              id="tpl-name"
              value={draft.name}
              placeholder="e.g. Summarise input"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            {submitted && nameError && <p className="text-xs text-red-500">{nameError}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="tpl-mode">Execution mode *</Label>
              <Select
                value={draft.executionMode}
                onValueChange={(v) =>
                  setDraft({ ...draft, executionMode: v as ExecutionMode })
                }
              >
                <SelectTrigger id="tpl-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct_llm">Direct LLM</SelectItem>
                  <SelectItem value="pipeline_run">Pipeline run</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.executionMode === "direct_llm" && (
              <div className="space-y-1">
                <Label htmlFor="tpl-model">Model</Label>
                <Select
                  value={draft.modelSlug ?? DEFAULT_MODEL_OPTION}
                  onValueChange={(v) =>
                    setDraft({ ...draft, modelSlug: resolveModelSlug(v) })
                  }
                >
                  <SelectTrigger id="tpl-model" aria-label="Model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_MODEL_OPTION}>
                      Default (server picks an active model)
                    </SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.slug} value={m.slug}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="tpl-desc">Description *</Label>
            <Textarea
              id="tpl-desc"
              rows={3}
              value={draft.description}
              placeholder="What should this task do?"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            {submitted && descError && <p className="text-xs text-red-500">{descError}</p>}
          </div>

          <div className="space-y-1">
            <Label htmlFor="tpl-labels">Labels</Label>
            <LabelChipEditor
              inputId="tpl-labels"
              ariaLabel="Add a label to this template"
              labels={draft.labels}
              onChange={(labels) => setDraft({ ...draft, labels })}
            />
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : submitLabel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TaskLibrary() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { toast } = useToast();
  const modelsQuery = useActiveModels();
  const models = (modelsQuery.data ?? []) as ModelOption[];

  const [labelFilter, setLabelFilter] = useState("");
  const list = useTaskTemplates({ label: labelFilter || null });
  const templates = useMemo(() => list.data?.items ?? [], [list.data]);

  const createMutation = useCreateTaskTemplate();
  const updateMutation = useUpdateTaskTemplate();
  const deleteMutation = useDeleteTaskTemplate();

  // null = list view; "new" = creating; otherwise the id being edited.
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const editingTemplate =
    typeof editing === "string" && editing !== "new"
      ? templates.find((t) => t.id === editing) ?? null
      : null;

  // Owner column shows only when the server returned createdBy (admins only).
  const showOwner = isAdmin && templates.some((t) => t.createdBy != null);

  async function handleCreate(draft: TemplateDraft) {
    try {
      await createMutation.mutateAsync(toPayload(draft));
      setEditing(null);
      toast({ title: "Template created" });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not create template",
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  async function handleUpdate(id: string, draft: TemplateDraft) {
    try {
      await updateMutation.mutateAsync({ id, ...toPayload(draft) });
      setEditing(null);
      toast({ title: "Template updated" });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not update template",
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      toast({ title: "Template deleted" });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not delete template",
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Library className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <div className="flex-1">
            <h1 className="text-2xl font-bold">Task Library</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Reusable task templates with labels. Compose them into groups from the
              composer's "Add from library".
            </p>
          </div>
          {editing === null && (
            <Button onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4 mr-2" />
              New template
            </Button>
          )}
        </div>

        {editing === "new" && (
          <TemplateEditor
            initial={emptyDraft()}
            models={models}
            pending={createMutation.isPending}
            submitLabel="Create"
            onSubmit={handleCreate}
            onCancel={() => setEditing(null)}
          />
        )}

        {editingTemplate && (
          <TemplateEditor
            initial={draftFromTemplate(editingTemplate)}
            models={models}
            pending={updateMutation.isPending}
            submitLabel="Save changes"
            onSubmit={(draft) => handleUpdate(editingTemplate.id, draft)}
            onCancel={() => setEditing(null)}
          />
        )}

        {/* Label filter */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-xs">
            <Input
              aria-label="Filter templates by label"
              placeholder="Filter by label…"
              value={labelFilter}
              onChange={(e) => setLabelFilter(e.target.value)}
            />
          </div>
          {labelFilter && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLabelFilter("")}
              aria-label="Clear label filter"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* List */}
        {list.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading templates…
          </div>
        ) : list.error ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Could not load templates.
            </CardContent>
          </Card>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {labelFilter
                ? `No templates labelled "${labelFilter}".`
                : "No templates yet. Create one to reuse it across groups."}
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-3" aria-label="Task templates">
            {templates.map((t) => (
              <li key={t.id}>
                <Card>
                  <CardHeader className="py-3 pb-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="text-sm font-medium">{t.name}</CardTitle>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t.executionMode}
                          {t.modelSlug ? ` · ${t.modelSlug}` : ""}
                          {showOwner && t.createdBy ? ` · owner: ${t.createdBy}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={`Edit template ${t.name}`}
                          onClick={() => setEditing(t.id)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-red-500"
                          aria-label={`Delete template ${t.name}`}
                          onClick={() => handleDelete(t.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="py-2 space-y-2">
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                    {t.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {t.labels.map((label) => (
                          <Badge key={label} variant="secondary" className="text-[10px]">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
