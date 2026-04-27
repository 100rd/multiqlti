import { useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePipelines, useStartRun } from "@/hooks/use-pipeline";
import { useToast } from "@/hooks/use-toast";

interface RunPipelineDialogProps {
  workspaceId: string;
  workspaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface PipelineSummary {
  id: string;
  name: string;
  description?: string | null;
  isTemplate?: boolean;
}

/**
 * Run-pipeline-against-this-workspace dialog (issue #343).
 *
 * Triggers POST /api/runs with workspaceId set so the run is bound to the
 * workspace. Workspace-aware tools (file-read, code-search, ...) will then
 * default to this workspace's path inside the run.
 */
export function RunPipelineDialog({
  workspaceId,
  workspaceName,
  open,
  onOpenChange,
}: RunPipelineDialogProps) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { data: pipelinesData, isLoading: pipelinesLoading } = usePipelines();
  const startRun = useStartRun();

  const [pipelineId, setPipelineId] = useState<string>("");
  const [taskInput, setTaskInput] = useState<string>("");

  // Filter out templates — runs target concrete pipelines.
  const pipelines: PipelineSummary[] = Array.isArray(pipelinesData)
    ? (pipelinesData as PipelineSummary[]).filter((p) => !p.isTemplate)
    : [];

  const canSubmit = pipelineId.length > 0 && taskInput.trim().length > 0 && !startRun.isPending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    startRun.mutate(
      {
        pipelineId,
        input: taskInput,
        workspaceId,
      } as Parameters<typeof startRun.mutate>[0],
      {
        onSuccess: (run: unknown) => {
          const runId = (run as Record<string, unknown>)?.id;
          if (runId && typeof runId === "string") {
            onOpenChange(false);
            setTaskInput("");
            setPipelineId("");
            navigate(`/runs/${runId}`);
          }
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : "Failed to start run";
          toast({
            title: "Could not start run",
            description: message,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run pipeline on {workspaceName}</DialogTitle>
          <DialogDescription>
            The selected pipeline will run with this workspace bound to the run. Workspace-aware
            tools (file-read, code-search, knowledge-search) will default to this workspace's
            files.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="pipeline-picker">Pipeline</Label>
            <Select value={pipelineId} onValueChange={setPipelineId} disabled={pipelinesLoading}>
              <SelectTrigger id="pipeline-picker" data-testid="run-pipeline-dialog-pipeline-picker">
                <SelectValue
                  placeholder={
                    pipelinesLoading
                      ? "Loading pipelines..."
                      : pipelines.length === 0
                      ? "No pipelines available"
                      : "Select a pipeline"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {pipelines.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <div className="flex flex-col items-start">
                      <span className="text-sm">{p.name}</span>
                      {p.description && (
                        <span className="text-[11px] text-muted-foreground line-clamp-1">
                          {p.description}
                        </span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="task-input">Task description</Label>
            <Textarea
              id="task-input"
              data-testid="run-pipeline-dialog-task-input"
              placeholder="What should the pipeline do? e.g., 'Add JWT auth to the express app'"
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={startRun.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="run-pipeline-dialog-submit"
          >
            {startRun.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run pipeline
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
