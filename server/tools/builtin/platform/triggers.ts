import { z } from "zod";
import { storage } from "../../../storage";
import type { ToolHandler } from "../../registry";
import { withConfirmation } from "./confirmation";

// ─── Input Schemas ──────────────────────────────────────────────────────────

const UpdateTriggerInput = z.object({
  id: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const DeleteTriggerInput = z.object({
  id: z.string().min(1),
  confirmed: z.boolean().optional(),
});

// ─── Tool Handlers ──────────────────────────────────────────────────────────

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
  updateTriggerHandler,
  deleteTriggerHandler,
];
