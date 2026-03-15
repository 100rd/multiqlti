import { useState } from "react";
import { Plus, Trash2, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface RequiredVar {
  key: string;
  description?: string;
  secret?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requiredVars?: RequiredVar[];
  /** Preserved variables from a previous failed run */
  preservedVars?: Record<string, string>;
  onConfirm: (variables: Record<string, string>) => void;
  isLoading?: boolean;
}

interface VarEntry {
  key: string;
  value: string;
  hidden: boolean;
}

function buildInitialEntries(
  requiredVars: RequiredVar[],
  preservedVars: Record<string, string>,
): VarEntry[] {
  const entries: VarEntry[] = [];
  const seen = new Set<string>();

  // Preserved vars take priority (pre-fill from previous run)
  for (const [key, value] of Object.entries(preservedVars)) {
    entries.push({ key, value, hidden: looksSecret(key, value) });
    seen.add(key);
  }

  // Required vars that aren't already filled
  for (const rv of requiredVars) {
    if (!seen.has(rv.key)) {
      entries.push({ key: rv.key, value: "", hidden: rv.secret ?? looksSecret(rv.key, "") });
      seen.add(rv.key);
    }
  }

  // Always have at least one empty row
  if (entries.length === 0) {
    entries.push({ key: "", value: "", hidden: false });
  }

  return entries;
}

function looksSecret(key: string, value: string): boolean {
  const secretPatterns = /password|secret|token|key|auth|credential|passwd/i;
  if (secretPatterns.test(key)) return true;
  if (value.includes("://") && value.includes("@")) return true;
  return false;
}

export function RunVariablesDialog({
  open,
  onOpenChange,
  requiredVars = [],
  preservedVars = {},
  onConfirm,
  isLoading = false,
}: Props) {
  const hasPreserved = Object.keys(preservedVars).length > 0;

  const [entries, setEntries] = useState<VarEntry[]>(() =>
    buildInitialEntries(requiredVars, preservedVars),
  );

  function updateEntry(index: number, field: "key" | "value", value: string) {
    setEntries((prev) =>
      prev.map((e, i) =>
        i === index
          ? { ...e, [field]: value, hidden: field === "key" ? looksSecret(value, e.value) : e.hidden }
          : e,
      ),
    );
  }

  function toggleHidden(index: number) {
    setEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, hidden: !e.hidden } : e)),
    );
  }

  function addRow() {
    setEntries((prev) => [...prev, { key: "", value: "", hidden: false }]);
  }

  function removeRow(index: number) {
    setEntries((prev) => prev.filter((_, i) => i !== index));
  }

  function handleConfirm() {
    const variables: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.key.trim()) {
        variables[entry.key.trim()] = entry.value;
      }
    }
    onConfirm(variables);
  }

  const missingRequired = requiredVars.filter((rv) => {
    const entry = entries.find((e) => e.key === rv.key);
    return !entry || !entry.value.trim();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Run Variables</DialogTitle>
          <DialogDescription>
            Ephemeral variables for this run only. Never stored in the database.
            {hasPreserved && (
              <span className="block mt-1 text-yellow-600 dark:text-yellow-400 font-medium">
                Pre-filled from a previous failed run.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {entries.map((entry, i) => {
            const isRequired = requiredVars.some((rv) => rv.key === entry.key);
            const requiredMeta = requiredVars.find((rv) => rv.key === entry.key);
            const isEmpty = isRequired && !entry.value.trim();

            return (
              <div key={i} className="flex items-start gap-2">
                <div className="flex-1">
                  {i === 0 && (
                    <Label className="text-xs text-muted-foreground mb-1 block">Key</Label>
                  )}
                  <Input
                    value={entry.key}
                    onChange={(e) => updateEntry(i, "key", e.target.value)}
                    placeholder="VARIABLE_NAME"
                    className="font-mono text-sm"
                    disabled={isRequired}
                  />
                  {requiredMeta?.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{requiredMeta.description}</p>
                  )}
                </div>

                <div className="flex-[2] relative">
                  {i === 0 && (
                    <Label className="text-xs text-muted-foreground mb-1 block">Value</Label>
                  )}
                  <div className="flex items-center gap-1">
                    <Input
                      type={entry.hidden ? "password" : "text"}
                      value={entry.value}
                      onChange={(e) => updateEntry(i, "value", e.target.value)}
                      placeholder={isRequired ? "required" : "value"}
                      className={`font-mono text-sm flex-1 ${isEmpty ? "border-yellow-400" : ""}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => toggleHidden(i)}
                    >
                      {entry.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>

                <div className={i === 0 ? "mt-5" : ""}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => removeRow(i)}
                    disabled={isRequired}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>

                {isRequired && (
                  <div className={i === 0 ? "mt-5" : ""}>
                    <Badge variant="outline" className="text-[10px] whitespace-nowrap">required</Badge>
                  </div>
                )}
              </div>
            );
          })}

          <Button type="button" variant="outline" size="sm" onClick={addRow} className="w-full">
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add variable
          </Button>

          {missingRequired.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Required: {missingRequired.map((r) => r.key).join(", ")}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isLoading || missingRequired.length > 0}
          >
            {isLoading ? "Starting…" : "Start Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
