import { z } from "zod";
import { storage } from "../../../storage";
import type { ToolHandler } from "../../registry";
import { withConfirmation } from "./confirmation";

// ─── Input Schemas ──────────────────────────────────────────────────────────

const CreatePipelineInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  stages: z.array(z.record(z.unknown())).min(1),
});

const UpdatePipelineInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  stages: z.array(z.record(z.unknown())).optional(),
});

const DeletePipelineInput = z.object({
  id: z.string().min(1),
  confirmed: z.boolean().optional(),
});

const RunPipelineInput = z.object({
  pipelineId: z.string().min(1),
  input: z.string().max(50000).optional(),
});

const CancelRunInput = z.object({
  runId: z.string().min(1),
  confirmed: z.boolean().optional(),
});

// ─── Tool Handlers ──────────────────────────────────────────────────────────

export const listPipelinesHandler: ToolHandler = {
  definition: {
    name: "list_pipelines",
    description: "List all pipelines configured in the platform.",
    inputSchema: { type: "object", properties: {}, required: [] },
    source: "builtin",
    tags: ["platform", "pipeline"],
  },
  async execute(): Promise<string> {
    const pipelines = await storage.getPipelines();
    if (pipelines.length === 0) return "No pipelines found.";
    return JSON.stringify(
      pipelines.map((p) => ({ id: p.id, name: p.name, description: p.description })),
    );
  },
};

export const createPipelineHandler: ToolHandler = {
  definition: {
    name: "create_pipeline",
    description: "Create a new pipeline with the given name, description, and stages.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Pipeline name" },
        description: { type: "string", description: "Pipeline description" },
        stages: {
          type: "array",
          items: { type: "object" },
          description: "Array of stage configuration objects",
        },
      },
      required: ["name", "stages"],
    },
    source: "builtin",
    tags: ["platform", "pipeline"],
  },
  async execute(args): Promise<string> {
    const input = CreatePipelineInput.parse(args);
    const pipeline = await storage.createPipeline({
      name: input.name,
      description: input.description ?? null,
      stages: input.stages,
    });
    return JSON.stringify({ id: pipeline.id, name: pipeline.name, created: true });
  },
};

export const updatePipelineHandler: ToolHandler = {
  definition: {
    name: "update_pipeline",
    description: "Update an existing pipeline's name, description, or stages.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Pipeline ID to update" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        stages: {
          type: "array",
          items: { type: "object" },
          description: "New stages array",
        },
      },
      required: ["id"],
    },
    source: "builtin",
    tags: ["platform", "pipeline"],
  },
  async execute(args): Promise<string> {
    const input = UpdatePipelineInput.parse(args);
    const existing = await storage.getPipeline(input.id);
    if (!existing) return JSON.stringify({ error: `Pipeline "${input.id}" not found.` });

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates["name"] = input.name;
    if (input.description !== undefined) updates["description"] = input.description;
    if (input.stages !== undefined) updates["stages"] = input.stages;

    const updated = await storage.updatePipeline(input.id, updates);
    return JSON.stringify({ id: updated.id, name: updated.name, updated: true });
  },
};

export const deletePipelineHandler: ToolHandler = withConfirmation({
  definition: {
    name: "delete_pipeline",
    description:
      "Delete a pipeline permanently. Requires confirmation — call once to get confirmation prompt, then again with confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Pipeline ID to delete" },
        confirmed: { type: "boolean", description: "Set to true to confirm deletion" },
      },
      required: ["id"],
    },
    source: "builtin",
    tags: ["platform", "pipeline", "destructive"],
  },
  action: "Delete pipeline",
  describeAction(args) {
    return `Permanently delete pipeline "${String(args["id"])}". This cannot be undone.`;
  },
  async executeConfirmed(args) {
    const input = DeletePipelineInput.parse(args);
    const existing = await storage.getPipeline(input.id);
    if (!existing) return JSON.stringify({ error: `Pipeline "${input.id}" not found.` });

    await storage.deletePipeline(input.id);
    return JSON.stringify({ id: input.id, deleted: true });
  },
});

export const runPipelineHandler: ToolHandler = {
  definition: {
    name: "run_pipeline",
    description: "Start a new run for the specified pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        pipelineId: { type: "string", description: "Pipeline ID to run" },
        input: { type: "string", description: "Input text for the pipeline run" },
      },
      required: ["pipelineId"],
    },
    source: "builtin",
    tags: ["platform", "pipeline", "run"],
  },
  async execute(args): Promise<string> {
    const input = RunPipelineInput.parse(args);
    const existing = await storage.getPipeline(input.pipelineId);
    if (!existing) {
      return JSON.stringify({ error: `Pipeline "${input.pipelineId}" not found.` });
    }

    const run = await storage.createPipelineRun({
      pipelineId: input.pipelineId,
      status: "pending",
      input: input.input ?? "",
      currentStageIndex: 0,
    });
    return JSON.stringify({ runId: run.id, pipelineId: input.pipelineId, status: "pending" });
  },
};

export const cancelRunHandler: ToolHandler = withConfirmation({
  definition: {
    name: "cancel_run",
    description:
      "Cancel an active pipeline run. Requires confirmation — call once for prompt, then with confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run ID to cancel" },
        confirmed: { type: "boolean", description: "Set to true to confirm cancellation" },
      },
      required: ["runId"],
    },
    source: "builtin",
    tags: ["platform", "pipeline", "run", "destructive"],
  },
  action: "Cancel pipeline run",
  describeAction(args) {
    return `Cancel active pipeline run "${String(args["runId"])}".`;
  },
  async executeConfirmed(args) {
    const input = CancelRunInput.parse(args);
    const run = await storage.getPipelineRun(input.runId);
    if (!run) return JSON.stringify({ error: `Run "${input.runId}" not found.` });

    if (run.status !== "running" && run.status !== "pending") {
      return JSON.stringify({ error: `Run "${input.runId}" is not active (status: ${run.status}).` });
    }

    const updated = await storage.updatePipelineRun(input.runId, { status: "cancelled" });
    return JSON.stringify({ runId: updated.id, status: updated.status, cancelled: true });
  },
});

export const pipelineTools: ToolHandler[] = [
  listPipelinesHandler,
  createPipelineHandler,
  updatePipelineHandler,
  deletePipelineHandler,
  runPipelineHandler,
  cancelRunHandler,
];
