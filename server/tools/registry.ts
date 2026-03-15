import type { ToolDefinition, ToolCall, ToolResult } from "@shared/types";

export interface ToolHandler {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}

export class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  register(handler: ToolHandler): void {
    this.tools.set(handler.definition.name, handler);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  getAvailableTools(filter?: { tags?: string[]; source?: 'builtin' | 'mcp' }): ToolDefinition[] {
    const all = Array.from(this.tools.values()).map((h) => h.definition);

    if (!filter) return all;

    return all.filter((def) => {
      if (filter.source && def.source !== filter.source) return false;
      if (filter.tags && filter.tags.length > 0) {
        const defTags = def.tags ?? [];
        if (!filter.tags.some((t) => defTags.includes(t))) return false;
      }
      return true;
    });
  }

  getToolByName(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const handler = this.tools.get(call.name);

    if (!handler) {
      return {
        toolCallId: call.id,
        content: `Tool "${call.name}" not found in registry.`,
        isError: true,
      };
    }

    try {
      const content = await handler.execute(call.arguments);
      return {
        toolCallId: call.id,
        content,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[tool-registry] Tool "${call.name}" threw: ${message}`);
      return {
        toolCallId: call.id,
        content: `Tool execution failed: ${message}`,
        isError: true,
      };
    }
  }
}
