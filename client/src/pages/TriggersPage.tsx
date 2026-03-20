import { useState } from "react";
import { Zap, Plus, Loader2, ZapOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TriggerCard } from "@/components/triggers/TriggerCard";
import { TriggerForm } from "@/components/triggers/TriggerForm";
import { useTriggers, useDeleteTrigger } from "@/hooks/use-triggers";
import { usePipelines } from "@/hooks/use-pipeline";
import type { PipelineTrigger } from "@shared/types";

interface Pipeline {
  id: string;
  name: string;
}

export default function TriggersPage() {
  const { data: triggers, isLoading: triggersLoading, error } = useTriggers();
  const { data: pipelinesData } = usePipelines();
  const deleteTrigger = useDeleteTrigger();

  const [formOpen, setFormOpen] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<PipelineTrigger | undefined>();

  const subsystemDisabled = (error as (Error & { disabled?: boolean }) | null)?.disabled === true || (error as (Error & { status?: number }) | null)?.status === 503;
  const triggerList: PipelineTrigger[] = Array.isArray(triggers) ? triggers : [];
  const pipelines: Pipeline[] = Array.isArray(pipelinesData) ? pipelinesData : [];

  function pipelineName(id: string): string {
    return pipelines.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  }

  function handleAdd() {
    setEditingTrigger(undefined);
    setFormOpen(true);
  }

  function handleEdit(trigger: PipelineTrigger) {
    setEditingTrigger(trigger);
    setFormOpen(true);
  }

  function handleDelete(trigger: PipelineTrigger) {
    if (!confirm(`Delete this ${trigger.type} trigger? This cannot be undone.`)) return;
    deleteTrigger.mutate(trigger.id);
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Triggers</h2>
          <p className="text-xs text-muted-foreground">
            Automate pipeline runs with webhooks, schedules, and events
          </p>
        </div>
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={handleAdd}
          disabled={pipelines.length === 0 || subsystemDisabled}
        >
          <Plus className="h-3 w-3 mr-2" />
          Add Trigger
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {triggersLoading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading triggers...
          </div>
        )}

        {error && !subsystemDisabled && (
          <div className="flex items-center justify-center py-16">
            <p className="text-sm text-destructive">
              Failed to load triggers: {error.message}
            </p>
          </div>
        )}

        {subsystemDisabled && (
          <div className="flex flex-col items-center justify-center py-16 text-center max-w-lg mx-auto">
            <ZapOff className="h-10 w-10 text-muted-foreground/40 mb-4" />
            <p className="text-base font-semibold mb-1">Trigger subsystem not configured</p>
            <p className="text-sm text-muted-foreground mb-6">
              To enable webhooks, schedules, and event triggers, set the{" "}
              <code className="font-mono bg-muted px-1 rounded text-xs">TRIGGER_SECRET_KEY</code> environment variable.
            </p>
            <div className="w-full text-left space-y-4">
              <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                <p className="text-sm font-medium">Setup steps</p>
                <ol className="space-y-3 text-sm text-muted-foreground list-none">
                  <li className="flex gap-3">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-medium">1</span>
                    <span>Generate a 64-character hex secret key:</span>
                  </li>
                  <li className="pl-8">
                    <code className="block font-mono text-xs bg-muted p-2 rounded select-all">
                      openssl rand -hex 32
                    </code>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-medium">2</span>
                    <span>Add it to your <code className="font-mono text-xs bg-muted px-1 rounded">.env</code> file:</span>
                  </li>
                  <li className="pl-8">
                    <code className="block font-mono text-xs bg-muted p-2 rounded select-all">
                      TRIGGER_SECRET_KEY=&lt;paste-your-64-char-key-here&gt;
                    </code>
                  </li>
                  <li className="flex gap-3">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-medium">3</span>
                    <span>Restart the platform for the change to take effect.</span>
                  </li>
                </ol>
              </div>
            </div>
          </div>
        )}

        {!triggersLoading && !error && triggerList.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Zap className="h-10 w-10 text-muted-foreground/40 mb-4" />
            <p className="text-sm font-medium text-muted-foreground">No triggers yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-6">
              Add one to automate your pipeline runs.
            </p>
            <Button size="sm" onClick={handleAdd} disabled={pipelines.length === 0}>
              <Plus className="h-3 w-3 mr-2" /> Add Trigger
            </Button>
            {pipelines.length === 0 && (
              <p className="text-xs text-muted-foreground mt-3">
                Create a pipeline first before adding triggers.
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 max-w-3xl">
          {triggerList.map((trigger) => (
            <TriggerCard
              key={trigger.id}
              trigger={trigger}
              pipelineName={pipelineName(trigger.pipelineId)}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      </div>

      <TriggerForm
        open={formOpen}
        onOpenChange={setFormOpen}
        pipelines={pipelines}
        trigger={editingTrigger}
      />
    </div>
  );
}
