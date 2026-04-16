/**
 * Per-stage connection picker (issue #269).
 *
 * Renders a multi-select list of workspace connections for a pipeline stage.
 * Only connections selected here are in the stage's allow-list at runtime.
 * Default is an empty list (deny-all).
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Link2Off } from "lucide-react";
import type { WorkspaceConnection } from "@shared/types";

// ─── Connection type display helpers ─────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  gitlab: "GitLab",
  github: "GitHub",
  kubernetes: "Kubernetes",
  aws: "AWS",
  jira: "Jira",
  grafana: "Grafana",
  generic_mcp: "Generic MCP",
};

// ─── Props ────────────────────────────────────────────────────────────────────

export interface StageConnectionPickerProps {
  /** All available connections for this workspace. */
  connections: WorkspaceConnection[];
  /** Currently selected connection IDs (the stage's allow-list). */
  selected: string[];
  /** Called when the allow-list changes. */
  onChange: (ids: string[]) => void;
  /** Disable editing (e.g. while saving). */
  disabled?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function StageConnectionPicker({
  connections,
  selected,
  onChange,
  disabled = false,
}: StageConnectionPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = connections.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.type.toLowerCase().includes(q) ||
      (TYPE_LABELS[c.type] ?? c.type).toLowerCase().includes(q)
    );
  });

  function toggle(id: string) {
    if (disabled) return;
    const next = selected.includes(id)
      ? selected.filter((s) => s !== id)
      : [...selected, id];
    onChange(next);
  }

  function selectAll() {
    if (disabled) return;
    onChange(filtered.map((c) => c.id));
  }

  function clearAll() {
    if (disabled) return;
    onChange([]);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="stage-connection-picker">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search connections…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-8 text-sm"
          disabled={disabled}
          aria-label="Search connections"
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {selected.length} of {connections.length} selected
        </span>
        <div className="flex gap-2">
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={selectAll}
            disabled={disabled || filtered.length === 0}
            type="button"
          >
            Select all
          </Button>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={clearAll}
            disabled={disabled || selected.length === 0}
            type="button"
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Deny-all notice */}
      {selected.length === 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <Link2Off className="h-3 w-3 shrink-0" />
          <span>
            No connections selected — this stage will run with <strong>no external connections</strong>{" "}
            (deny-all default).
          </span>
        </div>
      )}

      {/* Connection list */}
      <ScrollArea className="max-h-48 rounded-md border bg-background">
        {filtered.length === 0 ? (
          <p className="p-3 text-center text-xs text-muted-foreground">
            {connections.length === 0 ? "No connections defined for this workspace." : "No connections match your search."}
          </p>
        ) : (
          <ul className="divide-y" role="listbox" aria-multiselectable="true">
            {filtered.map((conn) => {
              const isSelected = selected.includes(conn.id);
              return (
                <li
                  key={conn.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
                  onClick={() => toggle(conn.id)}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(conn.id);
                    }
                  }}
                >
                  <Checkbox
                    id={`conn-${conn.id}`}
                    checked={isSelected}
                    onCheckedChange={() => toggle(conn.id)}
                    disabled={disabled}
                    aria-label={`Allow connection ${conn.name}`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Label
                      htmlFor={`conn-${conn.id}`}
                      className="cursor-pointer truncate text-sm font-medium"
                    >
                      {conn.name}
                    </Label>
                    <span className="text-xs text-muted-foreground">
                      {TYPE_LABELS[conn.type] ?? conn.type}
                    </span>
                  </div>
                  <Badge
                    variant={conn.status === "active" ? "default" : conn.status === "error" ? "destructive" : "secondary"}
                    className="shrink-0 text-xs"
                  >
                    {conn.status}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>

      {/* Selected badges */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((id) => {
            const conn = connections.find((c) => c.id === id);
            return (
              <Badge key={id} variant="outline" className="text-xs">
                {conn?.name ?? id}
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}
