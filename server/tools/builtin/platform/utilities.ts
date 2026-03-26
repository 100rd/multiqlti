import { z } from "zod";
import { storage } from "../../../storage";
import type { ToolHandler } from "../../registry";

// ─── Input Schemas ──────────────────────────────────────────────────────────

const CreateMemoryInput = z.object({
  key: z.string().min(1).max(500),
  content: z.string().min(1).max(10000),
  type: z.enum(["decision", "pattern", "issue", "preference", "fact"]).default("fact"),
  tags: z.array(z.string().max(100)).max(20).optional(),
});

const SearchMemoriesInput = z.object({
  query: z.string().min(1).max(1000),
});

const CreateGuardrailInput = z.object({
  pipelineId: z.string().min(1),
  stageIndex: z.number().int().min(0),
  guardrailType: z.enum(["word_count", "format_check", "keyword_block", "custom"]),
  config: z.record(z.unknown()).default({}),
});

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

export const createMemoryHandler: ToolHandler = {
  definition: {
    name: "create_memory",
    description: "Save a piece of knowledge (decision, pattern, fact, etc.) to the memory store.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short identifier for the memory" },
        content: { type: "string", description: "Full content of the memory" },
        type: {
          type: "string",
          enum: ["decision", "pattern", "issue", "preference", "fact"],
          description: "Memory type (default: fact)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization",
        },
      },
      required: ["key", "content"],
    },
    source: "builtin",
    tags: ["platform", "memory"],
  },
  async execute(args): Promise<string> {
    const input = CreateMemoryInput.parse(args);
    const memory = await storage.upsertMemory({
      scope: "global",
      type: input.type,
      key: input.key,
      content: input.content,
      tags: input.tags,
      confidence: 1.0,
    });
    return JSON.stringify({ id: memory.id, key: memory.key, saved: true });
  },
};

export const searchMemoriesHandler: ToolHandler = {
  definition: {
    name: "search_memories",
    description: "Search the knowledge base for relevant memories by query string.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    source: "builtin",
    tags: ["platform", "memory", "search"],
  },
  async execute(args): Promise<string> {
    const input = SearchMemoriesInput.parse(args);
    const memories = await storage.searchMemories(input.query);
    if (memories.length === 0) return `No memories found matching "${input.query}".`;
    return JSON.stringify(
      memories.map((m) => ({
        id: m.id,
        key: m.key,
        type: m.type,
        content: m.content,
        confidence: m.confidence,
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

export const createGuardrailHandler: ToolHandler = {
  definition: {
    name: "create_guardrail",
    description:
      "Add a guardrail to a specific stage of a pipeline. Guardrails validate stage output.",
    inputSchema: {
      type: "object",
      properties: {
        pipelineId: { type: "string", description: "Pipeline ID" },
        stageIndex: { type: "number", description: "Zero-based index of the stage" },
        guardrailType: {
          type: "string",
          enum: ["word_count", "format_check", "keyword_block", "custom"],
          description: "Type of guardrail to add",
        },
        config: { type: "object", description: "Guardrail configuration" },
      },
      required: ["pipelineId", "stageIndex", "guardrailType"],
    },
    source: "builtin",
    tags: ["platform", "pipeline", "guardrail"],
  },
  async execute(args): Promise<string> {
    const input = CreateGuardrailInput.parse(args);
    const pipeline = await storage.getPipeline(input.pipelineId);
    if (!pipeline) {
      return JSON.stringify({ error: `Pipeline "${input.pipelineId}" not found.` });
    }

    const stages = pipeline.stages as Record<string, unknown>[];
    if (input.stageIndex >= stages.length) {
      return JSON.stringify({
        error: `Stage index ${input.stageIndex} is out of range (pipeline has ${stages.length} stages).`,
      });
    }

    const stage = stages[input.stageIndex] as Record<string, unknown>;
    const existingGuardrails = (stage["guardrails"] as Record<string, unknown>[]) ?? [];
    const guardrail = { type: input.guardrailType, ...input.config };
    existingGuardrails.push(guardrail);
    stage["guardrails"] = existingGuardrails;
    stages[input.stageIndex] = stage;

    await storage.updatePipeline(input.pipelineId, { stages });
    return JSON.stringify({
      pipelineId: input.pipelineId,
      stageIndex: input.stageIndex,
      guardrailType: input.guardrailType,
      added: true,
    });
  },
};

export const utilityTools: ToolHandler[] = [
  listModelsHandler,
  createMemoryHandler,
  searchMemoriesHandler,
  listSkillsHandler,
  createGuardrailHandler,
];
