import { storage } from "../../../storage";
import type { ToolHandler } from "../../registry";

// ─── Tool Handlers ──────────────────────────────────────────────────────────

export const listModelsHandler: ToolHandler = {
  definition: {
    name: "list_models",
    description: "List all available LLM models registered in the platform.",
    inputSchema: { type: "object", properties: {}, required: [] },
    source: "builtin",
    tags: ["platform", "model"],
  },
  async execute(): Promise<string> {
    const models = await storage.getActiveModels();
    if (models.length === 0) return "No models available.";
    return JSON.stringify(
      models.map((m) => ({
        slug: m.slug,
        name: m.name,
        provider: m.provider,
        isActive: m.isActive,
      })),
    );
  },
};

export const listSkillsHandler: ToolHandler = {
  definition: {
    name: "list_skills",
    description: "List all available skills in the platform.",
    inputSchema: { type: "object", properties: {}, required: [] },
    source: "builtin",
    tags: ["platform", "skill"],
  },
  async execute(): Promise<string> {
    const skills = await storage.getSkills();
    if (skills.length === 0) return "No skills found.";
    return JSON.stringify(
      skills.map((s) => ({
        id: s.id,
        name: s.name,
        teamId: s.teamId,
        description: s.description,
      })),
    );
  },
};

export const utilityTools: ToolHandler[] = [
  listModelsHandler,
  listSkillsHandler,
];
