import { randomUUID } from "crypto";
import type { ThoughtNode, ThoughtTree } from "@shared/types";

/**
 * Collects and structures LLM reasoning steps, tool calls, and decisions
 * into a tree (DAG) structure that can be visualized on the frontend.
 *
 * Node types extracted:
 *   - <thinking>...</thinking>     → "reasoning"
 *   - "Let me think..." phrases    → "branch"
 *   - "On one hand / other hand"   → "branch" (two siblings)
 *   - "## Step N: ..." headings    → "reasoning"
 *   - Numbered list items "1. ..." → "reasoning"
 *   - "In conclusion / Therefore"  → "conclusion"
 *   - "Decision:" lines            → "decision"
 *
 * Parent linking:
 *   - branch nodes link to the most recently added reasoning/thinking node
 *   - conclusion nodes link to the most recently added branch or reasoning node
 */
export class ThoughtTreeCollector {
  private nodes: ThoughtNode[] = [];

  /**
   * Parse an LLM response for structured thought content.
   */
  addFromLlmResponse(content: string, model?: string): void {
    const now = Date.now();
    const meta = model ? { model } : undefined;

    // ── Track which node IDs we add in this call so we can link children ────
    const addedIds: string[] = [];

    const push = (node: ThoughtNode): void => {
      this.nodes.push(node);
      addedIds.push(node.id);
    };

    // ── 1. Extract <thinking>...</thinking> blocks → "reasoning" ────────────
    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
    let match: RegExpExecArray | null;
    while ((match = thinkingRegex.exec(content)) !== null) {
      const thinkingContent = match[1].trim();
      if (thinkingContent) {
        push({
          id: randomUUID(),
          parentId: null,
          type: "reasoning",
          label: "Thinking",
          content: thinkingContent,
          timestamp: now,
          metadata: meta,
        });
      }
    }

    // ── 2. Extract "## Step N: ..." headings → "reasoning" ──────────────────
    const stepRegex = /^#{1,3}\s+(?:Step\s+\d+[:.]\s*)(.+)$/gm;
    while ((match = stepRegex.exec(content)) !== null) {
      const label = match[1].trim();
      const headingEnd = match.index + match[0].length;
      const nextHeading = content.indexOf("\n#", headingEnd);
      const stepContent = (
        nextHeading > -1
          ? content.slice(headingEnd, nextHeading)
          : content.slice(headingEnd)
      ).trim();

      if (label && !label.match(/<thinking>/i)) {
        push({
          id: randomUUID(),
          parentId: null,
          type: "reasoning",
          label,
          content: stepContent || label,
          timestamp: now,
          metadata: meta,
        });
      }
    }

    // ── 3. Extract "Let me think..." phrases → "branch" ─────────────────────
    // Match sentences starting with reflective openers
    const thinkPhraseRegex =
      /(?:^|\n)((?:Let me (?:think|consider|analyze|break this down|walk through)|I(?:'ll| will) (?:think|consider|analyze|break|walk)|First,? let(?:'s| us) (?:think|consider|analyze))[^.\n]*[.!]?)/gi;
    while ((match = thinkPhraseRegex.exec(content)) !== null) {
      const phrase = match[1].trim();
      if (phrase.length > 5) {
        // Link to most recent reasoning node in this call if available
        const parentId = this.findRecentParent(addedIds, ["reasoning"]);
        const id = randomUUID();
        push({
          id,
          parentId,
          type: "branch",
          label: "Reasoning Branch",
          content: phrase,
          timestamp: now,
          metadata: meta,
        });
      }
    }

    // ── 4. Extract "On one hand... / On the other hand..." → two branch nodes
    const oneHandRegex =
      /On (?:one|the one) hand[,:]?\s*([^.]+\.)/gi;
    const otherHandRegex =
      /On (?:the other|another) hand[,:]?\s*([^.]+\.)/gi;

    const oneHandMatches: string[] = [];
    const otherHandMatches: string[] = [];

    while ((match = oneHandRegex.exec(content)) !== null) {
      oneHandMatches.push(match[1].trim());
    }
    while ((match = otherHandRegex.exec(content)) !== null) {
      otherHandMatches.push(match[1].trim());
    }

    // Emit pairs: "One hand" + "Other hand" as siblings under same parent
    const pairCount = Math.max(oneHandMatches.length, otherHandMatches.length);
    for (let i = 0; i < pairCount; i++) {
      const parentId = this.findRecentParent(addedIds, ["reasoning", "branch"]);
      if (oneHandMatches[i]) {
        push({
          id: randomUUID(),
          parentId,
          type: "branch",
          label: "On one hand",
          content: oneHandMatches[i],
          timestamp: now,
          metadata: meta,
        });
      }
      if (otherHandMatches[i]) {
        push({
          id: randomUUID(),
          parentId,
          type: "branch",
          label: "On the other hand",
          content: otherHandMatches[i],
          timestamp: now,
          metadata: meta,
        });
      }
    }

    // ── 5. Extract numbered list items "1. ...", "2. ..." → "reasoning" ─────
    // Only if not already captured by step headings above
    const numberedItemRegex = /^(\d+)\.\s+(.+)$/gm;
    const capturedByStep = new Set<number>();
    // Re-scan step headings to find which line numbers are already covered
    const stepHeadingRe = /^#{1,3}\s+Step\s+\d+/gm;
    let stepMatch: RegExpExecArray | null;
    while ((stepMatch = stepHeadingRe.exec(content)) !== null) {
      const lineNum = content.slice(0, stepMatch.index).split("\n").length;
      capturedByStep.add(lineNum);
    }

    const contentLines = content.split("\n");
    while ((match = numberedItemRegex.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split("\n").length;
      if (capturedByStep.has(lineNum)) continue;

      const itemNumber = parseInt(match[1], 10);
      const itemText = match[2].trim();

      if (itemText.length > 10 && itemNumber <= 20) {
        push({
          id: randomUUID(),
          parentId: null,
          type: "reasoning",
          label: `Step ${itemNumber}`,
          content: itemText,
          timestamp: now,
          metadata: meta,
        });
      }
    }
    // Avoid unused variable warning
    void contentLines;

    // ── 6. Extract conclusion markers → "conclusion" ─────────────────────────
    const conclusionRegex =
      /(?:^|[\n.!?]\s*)((?:In conclusion[,:]?|Therefore[,:]?|To summarize[,:]?|In summary[,:]?|Thus[,:]?|Overall[,:]?)[^.\n]*[.!]?)/gi;
    while ((match = conclusionRegex.exec(content)) !== null) {
      const conclusionText = match[1].trim();
      if (conclusionText.length > 10) {
        const parentId = this.findRecentParent(addedIds, ["reasoning", "branch"]);
        push({
          id: randomUUID(),
          parentId,
          type: "conclusion",
          label: "Conclusion",
          content: conclusionText,
          timestamp: now,
          metadata: meta,
        });
      }
    }

    // ── 7. Extract "Decision:" lines → "decision" ────────────────────────────
    const decisionRegex = /^(?:Final\s+)?Decision:\s*(.+)$/gim;
    while ((match = decisionRegex.exec(content)) !== null) {
      const decision = match[1].trim();
      if (decision) {
        push({
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

    // ── 8. Fallback: if nothing extracted, add a single reasoning node ────────
    if (addedIds.length === 0 && content.trim()) {
      const preview = content.length > 120 ? content.slice(0, 120) + "…" : content;
      push({
        id: randomUUID(),
        parentId: null,
        type: "reasoning",
        label: "Response",
        content: preview,
        timestamp: now,
        metadata: meta,
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

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Find the ID of the most recently added node (across all prior calls)
   * that has one of the specified types.  Returns null if none found.
   */
  private findRecentParent(
    addedThisCall: string[],
    types: ThoughtNode["type"][],
  ): string | null {
    const typeSet = new Set(types);

    // Look at nodes added in the current call (in reverse)
    for (let i = addedThisCall.length - 1; i >= 0; i--) {
      const id = addedThisCall[i];
      const node = this.nodes.find((n) => n.id === id);
      if (node && typeSet.has(node.type)) return id;
    }

    // Look at all prior nodes (in reverse)
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (!addedThisCall.includes(node.id) && typeSet.has(node.type)) {
        return node.id;
      }
    }

    return null;
  }
}
