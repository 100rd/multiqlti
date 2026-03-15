import { Button } from "@/components/ui/button";
import { LayoutDashboard, ShieldCheck, Save } from "lucide-react";

interface DAGToolbarProps {
  pipelineId: string;
  onAutoLayout: () => void;
  onValidate: () => void;
  onSave: () => void;
  isSaving?: boolean;
  isValidating?: boolean;
}

export function DAGToolbar({
  onAutoLayout,
  onValidate,
  onSave,
  isSaving,
  isValidating,
}: DAGToolbarProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
      <Button
        variant="ghost"
        size="sm"
        className="text-xs h-7 gap-1.5"
        onClick={onAutoLayout}
        aria-label="Auto-arrange stages in topological order"
      >
        <LayoutDashboard className="h-3.5 w-3.5" />
        Auto Layout
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="text-xs h-7 gap-1.5"
        onClick={onValidate}
        disabled={isValidating}
        aria-label="Validate DAG structure for cycles and invalid references"
      >
        <ShieldCheck className="h-3.5 w-3.5" />
        {isValidating ? "Validating..." : "Validate"}
      </Button>

      <div className="flex-1" />

      <Button
        size="sm"
        className="text-xs h-7 gap-1.5"
        onClick={onSave}
        disabled={isSaving}
        aria-label="Save DAG configuration"
      >
        <Save className="h-3.5 w-3.5" />
        {isSaving ? "Saving..." : "Save DAG"}
      </Button>
    </div>
  );
}
