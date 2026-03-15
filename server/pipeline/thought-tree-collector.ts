import { randomUUID } from "crypto";
import type { ThoughtNode, ThoughtTree } from "@shared/types";

/**
 * Collects and structures LLM reasoning steps, tool calls, and decisions
 * into a tree structure that can be visualized on the frontend.
 */
export class ThoughtTreeCollector {
  private nodes: ThoughtNode[] = [];

  /**
   * Parse an LLM response for structured thought content.
   * Extracts:
   *   - <thinking>...</thinking> blocks → reasoning nodes
   *   - ## Step N: ... headings → reasoning nodes
   *   - Lines starting with "Decision:" → decision nodes
   */
  addFromLlmResponse(content: string, model?: string): void {
    const now = Date.now();

    // Extract <thinking>...</thinking> blocks
    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
    let match: RegExpExecArray | null;
    while ((match = thinkingRegex.exec(content)) !== null) {
      const thinkingContent = match[1].trim();
      if (thinkingContent) {
        this.nodes.push({
          id: randomUUID(),
          parentId: null,
          type: "reasoning",
          label: "Thinking",
          content: thinkingContent,
          timestamp: now,
          metadata: model ? { model } : undefined,
        });
      }
    }

    // Extract ## Step N: heading blocks
    const stepRegex = /^#{1,3}\s+(?:Step\s+\d+[:.]\s*)(.+)$/gm;
    while ((match = stepRegex.exec(content)) !== null) {
      const label = match[1].trim();
      // Capture the content after this heading until the next heading
      const headingEnd = match.index + match[0].length;
      const nextHeading = content.indexOf("\n#", headingEnd);
      const stepContent = (
        nextHeading > -1
          ? content.slice(headingEnd, nextHeading)
          : content.slice(headingEnd)
      ).trim();

      if (label && !label.match(/<thinking>/i)) {
        this.nodes.push({
          id: randomUUID(),
          parentId: null,
          type: "reasoning",
          label,
          content: stepContent || label,
          timestamp: now,
          metadata: model ? { model } : undefined,
        });
      }
    }

    // Extract "Decision:" lines
    const decisionRegex = /^(?:Final\s+)?Decision:\s*(.+)$/gim;
    while ((match = decisionRegex.exec(content)) !== null) {
      const decision = match[1].trim();
      if (decision) {
        this.nodes.push({
          id: randomUUID(),
          parentId: null,
          type: "decision",
          label: "Decision",
          content: decision,
          timestamp: now,
          metadata: { decision, model },
        });
      }
    }

    // If no structured thoughts were found, add the whole content as a reasoning node
    if (this.nodes.length === 0 && content.trim()) {
      const preview = content.length > 120 ? content.slice(0, 120) + "…" : content;
      this.nodes.push({
        id: randomUUID(),
        parentId: null,
        type: "reasoning",
        label: "Response",
        content: preview,
        timestamp: now,
        metadata: model ? { model } : undefined,
      });
    }
  }

  /** Explicitly add a decision node. */
  addDecision(label: string, content: string): void {
    this.nodes.push({
      id: randomUUID(),
      parentId: null,
      type: "decision",
      label,
      content,
      timestamp: Date.now(),
      metadata: { decision: content },
    });
  }

  /**
   * Add a tool call node. Returns the node ID so the result can be linked.
   */
  addToolCall(toolName: string, args: string): string {
    const id = randomUUID();
    this.nodes.push({
      id,
      parentId: null,
      type: "tool_call",
      label: `Tool: ${toolName}`,
      content: args,
      timestamp: Date.now(),
      metadata: { toolName },
    });
    return id;
  }

  /** Add a tool result node linked to the preceding tool call. */
  addToolResult(parentId: string, result: string): void {
    this.nodes.push({
      id: randomUUID(),
      parentId,
      type: "tool_result",
      label: "Tool Result",
      content: result,
      timestamp: Date.now(),
    });
  }

  getTree(): ThoughtTree {
    return this.nodes;
  }

  serialize(): string {
    return JSON.stringify(this.nodes);
  }
}
