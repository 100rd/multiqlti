import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, GitMerge, ChevronRight, Loader2 } from "lucide-react";
import { usePipelines, useCreatePipeline, useDeletePipeline } from "@/hooks/use-pipeline";
import { DEFAULT_PIPELINE_STAGES } from "@shared/constants";
import type { PipelineStageConfig } from "@shared/types";

interface Pipeline {
  id: string;
  name: string;
  description?: string;
  stages: PipelineStageConfig[];
  createdAt?: string;
}

export default function PipelineList() {
  const [, navigate] = useLocation();
  const { data: pipelines, isLoading } = usePipelines();
  const createPipeline = useCreatePipeline();
  const deletePipeline = useDeletePipeline();

  const pipelineList: Pipeline[] = Array.isArray(pipelines) ? pipelines : [];

  const handleCreate = () => {
    createPipeline.mutate(
      {
        name: "New Pipeline",
        description: "Custom SDLC pipeline",
        stages: DEFAULT_PIPELINE_STAGES,
      },
      {
        onSuccess: (created: Pipeline) => {
          navigate(`/pipelines/${created.id}`);
        },
      },
    );
  };

  const handleOpen = (id: string) => {
    navigate(`/pipelines/${id}`);
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm("Delete this pipeline? This cannot be undone.")) return;
    deletePipeline.mutate(id);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Pipelines</h2>
          <p className="text-xs text-muted-foreground">Select or create a multi-agent SDLC pipeline</p>
        </div>
        <Button size="sm" className="h-8 text-xs" onClick={handleCreate} disabled={createPipeline.isPending}>
          {createPipeline.isPending
            ? <Loader2 className="h-3 w-3 mr-2 animate-spin" />
            : <Plus className="h-3 w-3 mr-2" />}
          New Pipeline
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading pipelines...
          </div>
        )}

        {!isLoading && pipelineList.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <GitMerge className="h-10 w-10 text-muted-foreground/40 mb-4" />
            <p className="text-sm font-medium text-muted-foreground">No pipelines yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-6">
              Create your first pipeline to get started
            </p>
            <Button size="sm" onClick={handleCreate} disabled={createPipeline.isPending}>
              <Plus className="h-3 w-3 mr-2" /> Create Pipeline
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 max-w-3xl">
          {pipelineList.map((pipeline) => {
            const enabledStages = pipeline.stages?.filter(s => s.enabled).length ?? 0;
            const totalStages = pipeline.stages?.length ?? 0;

            return (
              <Card
                key={pipeline.id}
                className="border-border p-5 cursor-pointer hover:bg-accent/30 transition-colors group"
                onClick={() => handleOpen(pipeline.id)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <GitMerge className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold truncate">{pipeline.name}</h3>
                      {pipeline.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">
                          {pipeline.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-2">
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                          {enabledStages}/{totalStages} stages active
                        </Badge>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {pipeline.id.slice(0, 8)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => handleDelete(e, pipeline.id)}
                    >
                      Delete
                    </Button>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
