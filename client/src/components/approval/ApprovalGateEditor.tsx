import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Plus, X } from "lucide-react";
import type { ApprovalGateConfig, ApprovalGateType, AutoApproveCondition } from "@shared/types";

// ── Constants ────────────────────────────────────────────────────────────────

const GATE_TYPES: Array<{ value: ApprovalGateType; label: string; description: string }> = [
  { value: "manual", label: "Manual", description: "Requires human approval" },
  { value: "auto", label: "Auto-Approve", description: "Approve when conditions met" },
  { value: "timeout", label: "Timeout", description: "Auto-proceed after time limit" },
];

const CONDITION_FIELDS: Array<{ value: AutoApproveCondition["field"]; label: string }> = [
  { value: "cost", label: "Cost (USD)" },
  { value: "tokens", label: "Tokens" },
  { value: "duration", label: "Duration (ms)" },
  { value: "status", label: "Status" },
];

const CONDITION_OPERATORS: Array<{ value: AutoApproveCondition["operator"]; label: string }> = [
  { value: "lt", label: "< less than" },
  { value: "lte", label: "<= at most" },
  { value: "gt", label: "> greater than" },
  { value: "gte", label: ">= at least" },
  { value: "eq", label: "= equals" },
];

const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 1440;

// ── Props ────────────────────────────────────────────────────────────────────

interface ApprovalGateEditorProps {
  approvalRequired: boolean;
  gateConfig: ApprovalGateConfig | undefined;
  onChange: (approvalRequired: boolean, gateConfig: ApprovalGateConfig | undefined) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createDefaultCondition(): AutoApproveCondition {
  return { field: "cost", operator: "lt", value: 1 };
}

function createDefaultGate(type: ApprovalGateType): ApprovalGateConfig {
  switch (type) {
    case "manual":
      return { type: "manual" };
    case "auto":
      return { type: "auto", conditions: [createDefaultCondition()] };
    case "timeout":
      return { type: "timeout", timeoutMinutes: 30, timeoutAction: "approve" };
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ApprovalGateEditor({
  approvalRequired,
  gateConfig,
  onChange,
}: ApprovalGateEditorProps) {
  const effectiveGate = gateConfig ?? { type: "manual" as const };

  const handleToggle = (checked: boolean) => {
    if (checked) {
      onChange(true, effectiveGate);
    } else {
      onChange(false, undefined);
    }
  };

  const handleGateTypeChange = (newType: ApprovalGateType) => {
    onChange(true, createDefaultGate(newType));
  };

  const handleConditionChange = (index: number, updated: AutoApproveCondition) => {
    const conditions = [...(effectiveGate.conditions ?? [])];
    conditions[index] = updated;
    onChange(true, { ...effectiveGate, conditions });
  };

  const handleAddCondition = () => {
    const conditions = [...(effectiveGate.conditions ?? []), createDefaultCondition()];
    onChange(true, { ...effectiveGate, conditions });
  };

  const handleRemoveCondition = (index: number) => {
    const conditions = (effectiveGate.conditions ?? []).filter((_, i) => i !== index);
    // Keep at least one condition
    if (conditions.length === 0) return;
    onChange(true, { ...effectiveGate, conditions });
  };

  const handleTimeoutMinutesChange = (raw: string) => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) return;
    const clamped = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, parsed));
    onChange(true, { ...effectiveGate, timeoutMinutes: clamped });
  };

  const handleTimeoutActionChange = (action: "approve" | "reject") => {
    onChange(true, { ...effectiveGate, timeoutAction: action });
  };

  return (
    <div className="pt-1 border-t border-border space-y-3">
      {/* Main toggle */}
      <div className="flex items-center justify-between">
        <label
          className="text-xs font-medium text-muted-foreground"
          id="approval-gate-label"
        >
          Require approval before next stage
        </label>
        <Switch
          checked={approvalRequired}
          onCheckedChange={handleToggle}
          aria-labelledby="approval-gate-label"
        />
      </div>

      {approvalRequired && (
        <div className="space-y-3 pl-2 border-l-2 border-border">
          {/* Gate type selector */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Gate type
            </label>
            <Select
              value={effectiveGate.type}
              onValueChange={(v) => handleGateTypeChange(v as ApprovalGateType)}
            >
              <SelectTrigger className="h-7 text-xs bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GATE_TYPES.map((gt) => (
                  <SelectItem key={gt.value} value={gt.value}>
                    <span>{gt.label}</span>
                    <span className="text-muted-foreground ml-1.5">
                      -- {gt.description}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Manual gate info */}
          {effectiveGate.type === "manual" && (
            <p className="text-[10px] text-muted-foreground">
              Pipeline will pause after this stage until a user manually approves or rejects the output.
            </p>
          )}

          {/* Auto-approve conditions */}
          {effectiveGate.type === "auto" && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground">
                All conditions must pass for automatic approval. If any condition fails, manual approval is required.
              </p>

              {(effectiveGate.conditions ?? []).map((condition, idx) => (
                <ConditionRow
                  key={idx}
                  condition={condition}
                  canRemove={(effectiveGate.conditions ?? []).length > 1}
                  onChange={(updated) => handleConditionChange(idx, updated)}
                  onRemove={() => handleRemoveCondition(idx)}
                />
              ))}

              {(effectiveGate.conditions ?? []).length < 10 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px] gap-1"
                  onClick={handleAddCondition}
                >
                  <Plus className="h-3 w-3" />
                  Add condition
                </Button>
              )}
            </div>
          )}

          {/* Timeout config */}
          {effectiveGate.type === "timeout" && (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Timeout (minutes)
                </label>
                <Input
                  type="number"
                  min={MIN_TIMEOUT}
                  max={MAX_TIMEOUT}
                  className="h-7 text-xs bg-background border-border w-28"
                  value={effectiveGate.timeoutMinutes ?? 30}
                  onChange={(e) => handleTimeoutMinutesChange(e.target.value)}
                  aria-label="Timeout in minutes"
                />
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {MIN_TIMEOUT} to {MAX_TIMEOUT} minutes (24 hours max)
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  On timeout
                </label>
                <RadioGroup
                  value={effectiveGate.timeoutAction ?? "approve"}
                  onValueChange={(v) => handleTimeoutActionChange(v as "approve" | "reject")}
                  className="gap-2"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="approve" id="timeout-approve" />
                    <Label htmlFor="timeout-approve" className="text-xs">
                      Auto-approve and continue
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="reject" id="timeout-reject" />
                    <Label htmlFor="timeout-reject" className="text-xs">
                      Auto-reject and stop pipeline
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Condition Row ────────────────────────────────────────────────────────────

interface ConditionRowProps {
  condition: AutoApproveCondition;
  canRemove: boolean;
  onChange: (updated: AutoApproveCondition) => void;
  onRemove: () => void;
}

function ConditionRow({ condition, canRemove, onChange, onRemove }: ConditionRowProps) {
  const isStatusField = condition.field === "status";

  return (
    <div className="flex items-center gap-1.5">
      {/* Field */}
      <Select
        value={condition.field}
        onValueChange={(v) =>
          onChange({
            ...condition,
            field: v as AutoApproveCondition["field"],
            // Reset value when switching between numeric/string fields
            value: v === "status" ? "completed" : 0,
          })
        }
      >
        <SelectTrigger className="h-7 text-[11px] bg-background border-border w-[100px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONDITION_FIELDS.map((f) => (
            <SelectItem key={f.value} value={f.value}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Operator */}
      <Select
        value={condition.operator}
        onValueChange={(v) =>
          onChange({ ...condition, operator: v as AutoApproveCondition["operator"] })
        }
      >
        <SelectTrigger className="h-7 text-[11px] bg-background border-border w-[110px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONDITION_OPERATORS.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Value */}
      {isStatusField ? (
        <Select
          value={String(condition.value)}
          onValueChange={(v) => onChange({ ...condition, value: v })}
        >
          <SelectTrigger className="h-7 text-[11px] bg-background border-border flex-1 min-w-[90px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="completed">completed</SelectItem>
            <SelectItem value="failed">failed</SelectItem>
            <SelectItem value="running">running</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <Input
          type="number"
          className="h-7 text-[11px] bg-background border-border flex-1 min-w-[70px]"
          value={typeof condition.value === "number" ? condition.value : 0}
          onChange={(e) => {
            const parsed = parseFloat(e.target.value);
            if (!isNaN(parsed)) {
              onChange({ ...condition, value: parsed });
            }
          }}
          aria-label={`Value for ${condition.field} condition`}
        />
      )}

      {/* Remove */}
      {canRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onRemove}
          aria-label="Remove condition"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}
