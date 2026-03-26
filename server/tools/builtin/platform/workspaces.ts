import { z } from "zod";
import { storage } from "../../../storage";
import type { ToolHandler } from "../../registry";
import { withConfirmation } from "./confirmation";

// ─── Input Schemas ──────────────────────────────────────────────────────────

const CreateWorkspaceInput = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["local", "remote"]),
  path: z.string().min(1).max(1000),
  branch: z.string().max(200).optional(),
});

const DeleteWorkspaceInput = z.object({
  id: z.string().min(1),
  confirmed: z.boolean().optional(),
});

// ─── Tool Handlers ──────────────────────────────────────────────────────────

export const listWorkspacesHandler: ToolHandler = {
  definition: {
    name: "list_workspaces",
    description: "List all workspaces in the platform.",
    inputSchema: { type: "object", properties: {}, required: [] },
    source: "builtin",
    tags: ["platform", "workspace"],
  },
  async execute(): Promise<string> {
    const workspaces = await storage.getWorkspaces();
    if (workspaces.length === 0) return "No workspaces found.";
    return JSON.stringify(
      workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        type: w.type,
        path: w.path,
        status: w.status,
      })),
    );
  },
};

export const createWorkspaceHandler: ToolHandler = {
  definition: {
    name: "create_workspace",
    description: "Create a new workspace with the given name, type, and path.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workspace name" },
        type: { type: "string", enum: ["local", "remote"], description: "Workspace type" },
        path: { type: "string", description: "Path or URL of the workspace" },
        branch: { type: "string", description: "Git branch (default: main)" },
      },
      required: ["name", "type", "path"],
    },
    source: "builtin",
    tags: ["platform", "workspace"],
  },
  async execute(args): Promise<string> {
    const input = CreateWorkspaceInput.parse(args);
    const workspace = await storage.createWorkspace({
      name: input.name,
      type: input.type,
      path: input.path,
      branch: input.branch ?? "main",
      status: "active",
    });
    return JSON.stringify({ id: workspace.id, name: workspace.name, created: true });
  },
};

export const deleteWorkspaceHandler: ToolHandler = withConfirmation({
  definition: {
    name: "delete_workspace",
    description:
      "Delete a workspace permanently. Requires confirmation — call once for prompt, then with confirmed=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Workspace ID to delete" },
        confirmed: { type: "boolean", description: "Set to true to confirm deletion" },
      },
      required: ["id"],
    },
    source: "builtin",
    tags: ["platform", "workspace", "destructive"],
  },
  action: "Delete workspace",
  describeAction(args) {
    return `Permanently delete workspace "${String(args["id"])}". This cannot be undone.`;
  },
  async executeConfirmed(args) {
    const input = DeleteWorkspaceInput.parse(args);
    const existing = await storage.getWorkspace(input.id);
    if (!existing) return JSON.stringify({ error: `Workspace "${input.id}" not found.` });

    await storage.deleteWorkspace(input.id);
    return JSON.stringify({ id: input.id, deleted: true });
  },
});

export const workspaceTools: ToolHandler[] = [
  listWorkspacesHandler,
  createWorkspaceHandler,
  deleteWorkspaceHandler,
];
