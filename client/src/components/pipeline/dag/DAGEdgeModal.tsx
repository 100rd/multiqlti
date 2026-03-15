import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DAGCondition, DAGConditionOperator, DAGEdge } from "@shared/types";

interface DAGEdgeModalProps {
  open: boolean;
  fromStageId: string;
  toStageId: string;
  initialEdge?: Partial<DAGEdge>;
  onSave: (edge: Pick<DAGEdge, "condition" | "label">) => void;
  onClose: () => void;
}

const OPERATORS: Array<{ value: DAGConditionOperator; label: string }> = [
  { value: "eq", label: "equals (=)" },
  { value: "neq", label: "not equals (!=)" },
  { value: "gt", label: "greater than (>)" },
  { value: "lt", label: "less than (<)" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "exists" },
];

export function DAGEdgeModal({
  open,
  fromStageId,
  toStageId,
  initialEdge,
  onSave,
  onClose,
}: DAGEdgeModalProps) {
  const [label, setLabel] = useState(initialEdge?.label ?? "");
  const [hasCondition, setHasCondition] = useState(!!initialEdge?.condition);
  const [field, setField] = useState(initialEdge?.condition?.field ?? "");
  const [operator, setOperator] = useState<DAGConditionOperator>(
    initialEdge?.condition?.operator ?? "eq",
  );
  const [value, setValue] = useState(
    initialEdge?.condition?.value !== undefined
      ? String(initialEdge.condition.value)
      : "",
  );

  const handleSave = () => {
    const condition: DAGCondition | undefined =
      hasCondition && field
        ? { field, operator, value: operator === "exists" ? undefined : value }
        : undefined;
    onSave({ condition, label: label || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md" aria-describedby="dag-edge-modal-desc">
        <DialogHeader>
          <DialogTitle>Configure Edge</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm" id="dag-edge-modal-desc">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">From Stage</label>
              <div className="mt-1 rounded border border-border bg-muted px-2 py-1.5 text-xs font-mono text-foreground">
                {fromStageId}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">To Stage</label>
              <div className="mt-1 rounded border border-border bg-muted px-2 py-1.5 text-xs font-mono text-foreground">
                {toStageId}
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="edge-label" className="text-xs font-medium text-muted-foreground">
              Label (optional)
            </label>
            <Input
              id="edge-label"
              className="mt-1 h-8 text-xs"
              placeholder="e.g. happy path"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="rounded border border-border p-3 space-y-3">
            <div className="flex items-center gap-2">
              <input
                id="has-condition"
                type="checkbox"
                checked={hasCondition}
                onChange={(e) => setHasCondition(e.target.checked)}
                className="rounded"
                aria-label="Enable conditional routing"
              />
              <label htmlFor="has-condition" className="text-xs font-medium cursor-pointer">
                Conditional routing
              </label>
            </div>

            {hasCondition && (
              <div className="space-y-2 pt-1">
                <div>
                  <label htmlFor="condition-field" className="text-xs text-muted-foreground">
                    Field path (e.g. techStack or result.score)
                  </label>
                  <Input
                    id="condition-field"
                    className="mt-1 h-8 text-xs font-mono"
                    placeholder="field.path"
                    value={field}
                    onChange={(e) => setField(e.target.value)}
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground">Operator</label>
                  <Select value={operator} onValueChange={(v) => setOperator(v as DAGConditionOperator)}>
                    <SelectTrigger className="mt-1 h-8 text-xs">
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

                {operator !== "exists" && (
                  <div>
                    <label htmlFor="condition-value" className="text-xs text-muted-foreground">
                      Value
                    </label>
                    <Input
                      id="condition-value"
                      className="mt-1 h-8 text-xs"
                      placeholder="comparison value"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Cancel edge configuration">
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} aria-label="Save edge configuration">
            Save Edge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
