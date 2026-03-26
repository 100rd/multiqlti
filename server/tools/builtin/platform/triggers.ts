import { z } from "zod";
import { storage } from "../../../storage";
import type { ToolHandler } from "../../registry";
import type { TriggerConfig } from "@shared/types";
import { withConfirmation } from "./confirmation";

// ─── Input Schemas ──────────────────────────────────────────────────────────

const CreateTriggerInput = z.object({
  pipelineId: z.string().min(1),
  type: z.enum(["webhook", "schedule", "github_event", "file_change"]),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

const UpdateTriggerInput = z.object({
  id: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const DeleteTriggerInput = z.object({
  id: z.string().min(1),
  confirmed: z.boolean().optional(),
});

const ListTriggersInput = z.object({
  pipelineId: z.string().min(1),
});

// ─── Tool Handlers ──────────────────────────────────────────────────────────

export const listTriggersHandler: ToolHandler = {
  definition: {
    name: "list_triggers",
    description: "List all triggers for a given pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        pipelineId: { type: "string", description: "Pipeline ID to list triggers for" },
      },
      required: ["pipelineId"],
    },
    source: "builtin",
    tags: ["platform", "trigger"],
  },
  async execute(args): Promise<string> {
    const input = ListTriggersInput.parse(args);
    const triggers = await storage.getTriggers(input.pipelineId);
    if (triggers.length === 0) {
      return `No triggers found for pipeline "${input.pipelineId}".`;
    }
    return JSON.stringify(
      triggers.map((t) => ({
        id: t.id,
        type: t.type,
        enabled: t.enabled,
        config: t.config,
      })),
    );
  },
};

export const createTriggerHandler: ToolHandler = {
  definition: {
    name: "create_trigger",
    description: "Create a new trigger for a pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        pipelineId: { type: "string", description: "Pipeline ID to attach the trigger to" },
        type: {
          type: "string",
          enum: ["webhook", "schedule", "github_event", "file_change"],
          description: "Trigger type",
        },
        config: { type: "object", description: "Trigger-specific configuration" },
        enabled: { type: "boolean", description: "Whether the trigger is active (default: true)" },
      },
      required: ["pipelineId", "type"],
    },
    source: "builtin",
    tags: ["platform", "trigger"],
  },
  async execute(args): Promise<string> {
    const input = CreateTriggerInput.parse(args);
    const pipeline = await storage.getPipeline(input.pipelineId);
    if (!pipeline) {
      return JSON.stringify({ error: `Pipeline "${input.pipelineId}" not found.` });
    }

    const trigger = await storage.createTrigger({
      pipelineId: input.pipelineId,
      type: input.type,
      config: input.config as unknown as TriggerConfig,
      secretEncrypted: null,
      enabled: input.enabled,
    });
    return JSON.stringify({ id: trigger.id, type: trigger.type, created: true });
  },
};

export const updateTriggerHandler: ToolHandler = {
  definition: {
    name: "update_trigger",
    description: "Update an existing trigger's configuration or enabled status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Trigger ID to update" },
        config: { type: "object", description: "New trigger configuration" },
        enabled: { type: "boolean", description: "Enable or disable the trigger" },
      },
      required: ["id"],
    },
    source: "builtin",
    tags: ["platform", "trigger"],
  },
  async execute(args): Promise<string> {
    const input = UpdateTriggerInput.parse(args);
    const existing = await storage.getTrigger(input.id);
    if (!existing) return JSON.stringify({ error: `Trigger "${input.id}" not found.` });

    const updates: Record<string, unknown> = {};
    if (input.config !== undefined) updates["config"] = input.config;
    if (input.enabled !== undefined) updates["enabled"] = input.enabled;

    const updated = await storage.updateTrigger(input.id, updates);
    return JSON.stringify({ id: updated.id, type: updated.type, updated: true });
  },
};

export const deleteTriggerHandler: ToolHandler = withConfirmation({
  definition: {
    name: "delete_trigger",
    description:
      "Delete a trigger permanently. Requires confirmation — call once for prompt, then with confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Trigger ID to delete" },
        confirmed: { type: "boolean", description: "Set to true to confirm deletion" },
      },
      required: ["id"],
    },
    source: "builtin",
    tags: ["platform", "trigger", "destructive"],
  },
  action: "Delete trigger",
  describeAction(args) {
    return `Permanently delete trigger "${String(args["id"])}". This cannot be undone.`;
  },
  async executeConfirmed(args) {
    const input = DeleteTriggerInput.parse(args);
    const existing = await storage.getTrigger(input.id);
    if (!existing) return JSON.stringify({ error: `Trigger "${input.id}" not found.` });

    await storage.deleteTrigger(input.id);
    return JSON.stringify({ id: input.id, deleted: true });
  },
});

export const triggerTools: ToolHandler[] = [
  listTriggersHandler,
  createTriggerHandler,
  updateTriggerHandler,
  deleteTriggerHandler,
];
