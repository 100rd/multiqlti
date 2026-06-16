/**
 * "Add from library" template picker (FE4). A dialog-less inline panel that lists
 * the caller's owner-scoped templates (filtered by label), lets them check one or
 * more, and seeds the picked templates as TaskDraft rows via the pure
 * seedTasksFromTemplates reducer (copy-in client-side; the server re-copies
 * authoritatively via templateId). Manual task creation is unaffected.
 *
 * SECURITY: template text is rendered as INERT React text. The label filter is
 * server-validated + parameterized.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, X } from "lucide-react";
import { useTaskTemplates, type TaskTemplate } from "@/hooks/use-task-templates";
import type { TemplateSeed } from "./task-form-logic";

interface TemplatePickerProps {
  onAdd: (templates: TemplateSeed[]) => void;
  onClose: () => void;
}

/** Map a library row to the seed shape the reducer copies in. */
function toSeed(t: TaskTemplate): TemplateSeed {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    executionMode: t.executionMode,
    modelSlug: t.modelSlug,
    input: t.input,
    labels: t.labels,
  };
}

export function TemplatePicker({ onAdd, onClose }: TemplatePickerProps) {
  const [labelFilter, setLabelFilter] = useState("");
  const list = useTaskTemplates({ label: labelFilter || null });
  const templates = useMemo(() => list.data?.items ?? [], [list.data]);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleAdd() {
    const seeds = templates.filter((t) => picked.has(t.id)).map(toSeed);
    if (seeds.length > 0) onAdd(seeds);
    onClose();
  }

  return (
    <Card aria-labelledby="picker-heading">
      <CardHeader className="py-3 flex flex-row items-center justify-between space-y-0">
        <CardTitle id="picker-heading" className="text-base">
          Add from library
        </CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close library picker">
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          aria-label="Filter templates by label"
          placeholder="Filter by label…"
          value={labelFilter}
          onChange={(e) => setLabelFilter(e.target.value)}
        />

        {list.isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading templates…
          </div>
        ) : templates.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {labelFilter
              ? `No templates labelled "${labelFilter}".`
              : "No templates in your library yet."}
          </p>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto" aria-label="Library templates">
            {templates.map((t) => {
              const checked = picked.has(t.id);
              return (
                <li key={t.id}>
                  <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-2 hover:bg-muted/50">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-primary"
                      checked={checked}
                      onChange={() => toggle(t.id)}
                      aria-label={`Select template ${t.name}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{t.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.description}
                      </span>
                      {t.labels.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {t.labels.map((label) => (
                            <Badge key={label} variant="secondary" className="text-[10px]">
                              {label}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleAdd} disabled={picked.size === 0}>
            Add {picked.size > 0 ? `(${picked.size})` : ""}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
