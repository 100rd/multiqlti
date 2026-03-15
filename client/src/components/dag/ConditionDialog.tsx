/**
 * ConditionDialog — Phase 6.2
 *
 * Modal for editing a DAGCondition on an edge.
 * Fields: field path, operator, optional value.
 */
import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export type DAGConditionOperator = "eq" | "neq" | "gt" | "lt" | "contains" | "exists";

export interface DAGCondition {
  field: string;
  operator: DAGConditionOperator;
  value?: string | number | boolean | null;
}

interface ConditionDialogProps {
  open: boolean;
  initial?: DAGCondition | null;
  edgeLabel?: string;
  onSave: (condition: DAGCondition | null) => void;
  onClose: () => void;
}

const OPERATORS: { value: DAGConditionOperator; label: string }[] = [
  { value: "eq", label: "equals (=)" },
  { value: "neq", label: "not equals (!=)" },
  { value: "gt", label: "greater than (>)" },
  { value: "lt", label: "less than (<)" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "exists" },
];

const FIELD_RE = /^[a-zA-Z0-9_]{1,50}(\.[a-zA-Z0-9_]{1,50}){0,2}$/;

export default function ConditionDialog({
  open, initial, edgeLabel, onSave, onClose,
}: ConditionDialogProps) {
  const [field, setField] = useState(initial?.field ?? "");
  const [operator, setOperator] = useState<DAGConditionOperator>(initial?.operator ?? "eq");
  const [value, setValue] = useState(
    initial?.value != null ? String(initial.value) : "",
  );
  const [fieldError, setFieldError] = useState("");

  useEffect(() => {
    if (open) {
      setField(initial?.field ?? "");
      setOperator(initial?.operator ?? "eq");
      setValue(initial?.value != null ? String(initial.value) : "");
      setFieldError("");
    }
  }, [open, initial]);

  const needsValue = operator !== "exists";

  function handleSave() {
    if (!field.trim()) {
      setFieldError("Field path is required");
      return;
    }
    if (!FIELD_RE.test(field.trim())) {
      setFieldError("Use alphanumeric+underscore segments, max 3 levels (e.g. result.score)");
      return;
    }
    setFieldError("");

    const parsed = needsValue ? parseValue(value) : undefined;
    onSave({ field: field.trim(), operator, value: parsed });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {edgeLabel ? `Edge condition: ${edgeLabel}` : "Edge condition"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            If this condition evaluates to true, the downstream stage will be triggered.
            Leave empty to always proceed (unconditional edge).
          </p>

          <div className="space-y-1">
            <Label htmlFor="field" className="text-xs">Output field path</Label>
            <Input
              id="field"
              className="h-8 text-xs font-mono"
              placeholder="e.g. score or result.label"
              value={field}
              onChange={(e) => {
                setField(e.target.value);
                setFieldError("");
              }}
            />
            {fieldError && (
              <p className="text-xs text-destructive">{fieldError}</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="operator" className="text-xs">Operator</Label>
            <Select
              value={operator}
              onValueChange={(v) => setOperator(v as DAGConditionOperator)}
            >
              <SelectTrigger id="operator" className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPERATORS.map((op) => (
                  <SelectItem key={op.value} value={op.value} className="text-xs">
                    {op.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {needsValue && (
            <div className="space-y-1">
              <Label htmlFor="value" className="text-xs">
                Value
                <span className="text-muted-foreground ml-1">(string, number, or true/false)</span>
              </Label>
              <Input
                id="value"
                className="h-8 text-xs"
                placeholder='e.g. "approved" or 0.8 or true'
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => onSave(null)}>
            Remove condition
          </Button>
          <Button variant="outline" size="sm" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" className="text-xs" onClick={handleSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function parseValue(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const num = Number(trimmed);
  if (trimmed !== "" && !isNaN(num)) return num;
  return trimmed;
}
