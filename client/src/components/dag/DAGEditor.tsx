/**
 * DAGEditor — Phase 6.2
 *
 * Wraps DAGCanvas + ConditionDialog into a complete editor with
 * Save / Validate / Clear controls.
 */
import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Save, CheckCircle, Trash2, Loader2, AlertTriangle } from "lucide-react";
import DAGCanvas from "./DAGCanvas";
import type { DAGStageNode, DAGEdgeData } from "./DAGCanvas";
import ConditionDialog from "./ConditionDialog";
import type { DAGCondition } from "./ConditionDialog";
import { useSaveDAG, useValidateDAG } from "@/hooks/use-dag";
import { useToast } from "@/hooks/use-toast";

interface DAGEditorProps {
  pipelineId: string;
  initialStages?: DAGStageNode[];
  initialEdges?: DAGEdgeData[];
}

interface ValidationResult {
  valid: boolean;
  issues?: Array<{ path: (string | number)[]; message: string }>;
}

export default function DAGEditor({
  pipelineId,
  initialStages = [],
  initialEdges = [],
}: DAGEditorProps) {
  const [stages, setStages] = useState<DAGStageNode[]>(initialStages);
  const [edges, setEdges] = useState<DAGEdgeData[]>(initialEdges);

  const [conditionDialog, setConditionDialog] = useState<{
    open: boolean;
    edgeId: string | null;
    current: DAGCondition | null | undefined;
  }>({ open: false, edgeId: null, current: null });

  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const saveDAG = useSaveDAG(pipelineId);
  const validateDAG = useValidateDAG(pipelineId);
  const { toast } = useToast();

  const handleStagesChange = useCallback((next: DAGStageNode[]) => {
    setStages(next);
    setIsDirty(true);
    setValidationResult(null);
  }, []);

  const handleEdgesChange = useCallback((next: DAGEdgeData[]) => {
    setEdges(next);
    setIsDirty(true);
    setValidationResult(null);
  }, []);

  const handleEdgeConditionClick = useCallback(
    (edgeId: string, current?: DAGCondition | null) => {
      setConditionDialog({ open: true, edgeId, current: current ?? null });
    },
    [],
  );

  const handleConditionSave = useCallback(
    (condition: DAGCondition | null) => {
      if (conditionDialog.edgeId == null) return;
      setEdges((prev) =>
        prev.map((e) =>
          e.id === conditionDialog.edgeId
            ? { ...e, condition: condition ?? undefined }
            : e,
        ),
      );
      setConditionDialog({ open: false, edgeId: null, current: null });
      setIsDirty(true);
      setValidationResult(null);
    },
    [conditionDialog.edgeId],
  );

  const buildDAGPayload = useCallback(
    () => ({
      stages: stages.map((s) => ({
        id: s.id,
        teamId: s.teamId,
        modelSlug: s.modelSlug,
        enabled: s.enabled,
        position: s.position,
        label: s.label,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        condition: e.condition ?? undefined,
        label: e.label,
      })),
    }),
    [edges, stages],
  );

  const handleValidate = useCallback(async () => {
    const payload = buildDAGPayload();
    try {
      const result = await validateDAG.mutateAsync(payload) as ValidationResult;
      setValidationResult(result);
    } catch {
      toast({ title: "Validation error", variant: "destructive" });
    }
  }, [buildDAGPayload, toast, validateDAG]);

  const handleSave = useCallback(async () => {
    const payload = buildDAGPayload();
    try {
      await saveDAG.mutateAsync(payload);
      setIsDirty(false);
      toast({ title: "DAG saved" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed";
      toast({ title: "Save failed", description: message, variant: "destructive" });
    }
  }, [buildDAGPayload, saveDAG, toast]);

  const handleClear = useCallback(() => {
    setStages([]);
    setEdges([]);
    setIsDirty(true);
    setValidationResult(null);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1"
          onClick={handleValidate}
          disabled={validateDAG.isPending}
        >
          {validateDAG.isPending
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <CheckCircle className="h-3 w-3" />}
          Validate
        </Button>

        <Button
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={handleSave}
          disabled={!isDirty || saveDAG.isPending}
        >
          {saveDAG.isPending
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <Save className="h-3 w-3" />}
          Save DAG
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
          onClick={handleClear}
        >
          <Trash2 className="h-3 w-3" /> Clear
        </Button>

        {isDirty && (
          <Badge variant="outline" className="text-xs text-muted-foreground">
            Unsaved changes
          </Badge>
        )}

        {validationResult && (
          validationResult.valid ? (
            <Badge variant="outline" className="text-xs text-green-600 border-green-600 gap-1">
              <CheckCircle className="h-3 w-3" /> Valid DAG
            </Badge>
          ) : (
            <Badge variant="destructive" className="text-xs gap-1">
              <AlertTriangle className="h-3 w-3" />
              {validationResult.issues?.[0]?.message ?? "Invalid DAG"}
            </Badge>
          )
        )}
      </div>

      {/* Canvas */}
      <DAGCanvas
        stages={stages}
        edges={edges}
        onStagesChange={handleStagesChange}
        onEdgesChange={handleEdgesChange}
        onEdgeConditionClick={handleEdgeConditionClick}
      />

      {/* Condition dialog */}
      <ConditionDialog
        open={conditionDialog.open}
        initial={conditionDialog.current}
        edgeLabel={
          conditionDialog.edgeId
            ? edges.find((e) => e.id === conditionDialog.edgeId)?.label
            : undefined
        }
        onSave={handleConditionSave}
        onClose={() => setConditionDialog({ open: false, edgeId: null, current: null })}
      />
    </div>
  );
}
