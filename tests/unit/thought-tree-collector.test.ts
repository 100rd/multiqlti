/**
 * Unit tests for ThoughtTreeCollector — node extraction, type classification,
 * parent linking, and edge cases.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ThoughtTreeCollector } from "../../server/pipeline/thought-tree-collector.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCollector(): ThoughtTreeCollector {
  return new ThoughtTreeCollector();
}

// ─── Existing patterns (regression) ──────────────────────────────────────────

describe("ThoughtTreeCollector — existing patterns", () => {
  it("extracts <thinking> blocks as 'reasoning' nodes", () => {
    const c = makeCollector();
    c.addFromLlmResponse("<thinking>I need to consider X</thinking>", "claude");
    const tree = c.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe("reasoning");
    expect(tree[0].content).toBe("I need to consider X");
    expect(tree[0].metadata?.model).toBe("claude");
  });

  it("extracts ## Step N: headings as 'reasoning' nodes", () => {
    const c = makeCollector();
    c.addFromLlmResponse("## Step 1: Analyse the problem\nSome analysis here.\n## Step 2: Design\nDesign content.");
    const tree = c.getTree();
    const stepNodes = tree.filter((n) => n.type === "reasoning");
    expect(stepNodes.length).toBeGreaterThanOrEqual(2);
    expect(stepNodes[0].label).toBe("Analyse the problem");
  });

  it("extracts 'Decision:' lines as 'decision' nodes", () => {
    const c = makeCollector();
    c.addFromLlmResponse("Decision: Use approach A.\nSome other content.");
    const tree = c.getTree();
    const decisions = tree.filter((n) => n.type === "decision");
    expect(decisions.length).toBe(1);
    expect(decisions[0].content).toBe("Use approach A.");
  });

  it("falls back to a single 'reasoning' node if no patterns match", () => {
    const c = makeCollector();
    c.addFromLlmResponse("Plain text response with no special markers.");
    const tree = c.getTree();
    expect(tree.length).toBe(1);
    expect(tree[0].type).toBe("reasoning");
    expect(tree[0].label).toBe("Response");
  });

  it("produces no nodes for empty content", () => {
    const c = makeCollector();
    c.addFromLlmResponse("");
    expect(c.getTree()).toHaveLength(0);
  });

  it("produces no nodes for whitespace-only content", () => {
    const c = makeCollector();
    c.addFromLlmResponse("   \n   \t  ");
    expect(c.getTree()).toHaveLength(0);
  });
});

// ─── New patterns (Phase 6.13.3) ─────────────────────────────────────────────

describe("ThoughtTreeCollector — 'Let me think' → 'branch' nodes", () => {
  it("extracts 'Let me think...' phrase as a 'branch' node", () => {
    const c = makeCollector();
    c.addFromLlmResponse("Let me think about this carefully.");
    const branches = c.getTree().filter((n) => n.type === "branch");
    expect(branches.length).toBe(1);
    expect(branches[0].label).toBe("Reasoning Branch");
  });

  it("extracts 'Let me consider...' phrase as a 'branch' node", () => {
    const c = makeCollector();
    c.addFromLlmResponse("Let me consider the trade-offs.");
    const branches = c.getTree().filter((n) => n.type === "branch");
    expect(branches.length).toBeGreaterThanOrEqual(1);
  });

  it("links branch to preceding reasoning node when available", () => {
    const c = makeCollector();
    c.addFromLlmResponse("<thinking>First I reason here</thinking>\nLet me think about the implications.");
    const tree = c.getTree();
    const branch = tree.find((n) => n.type === "branch");
    const reasoning = tree.find((n) => n.type === "reasoning");
    expect(branch).toBeDefined();
    expect(reasoning).toBeDefined();
    // branch should link to the reasoning node
    expect(branch?.parentId).toBe(reasoning?.id);
  });
});

describe("ThoughtTreeCollector — 'On one hand / other hand' → 'branch' nodes", () => {
  it("extracts 'On one hand...' and 'On the other hand...' as branch nodes", () => {
    const c = makeCollector();
    c.addFromLlmResponse(
      "On one hand, approach A is fast. On the other hand, approach B is safer."
    );
    const branches = c.getTree().filter((n) => n.type === "branch");
    expect(branches.length).toBe(2);
    expect(branches[0].label).toBe("On one hand");
    expect(branches[1].label).toBe("On the other hand");
  });

  it("handles 'On the one hand' variant", () => {
    const c = makeCollector();
    c.addFromLlmResponse("On the one hand, X is good. On the other hand, Y is better.");
    const branches = c.getTree().filter((n) => n.type === "branch");
    expect(branches.length).toBe(2);
  });

  it("emits only 'other hand' node if no 'one hand' is present", () => {
    const c = makeCollector();
    c.addFromLlmResponse("On the other hand, approach B is safer.");
    const branches = c.getTree().filter((n) => n.type === "branch");
    expect(branches.length).toBe(1);
    expect(branches[0].label).toBe("On the other hand");
  });
});

describe("ThoughtTreeCollector — numbered list → 'reasoning' nodes", () => {
  it("extracts numbered list items as 'reasoning' nodes", () => {
    const c = makeCollector();
    c.addFromLlmResponse("Here are my steps:\n1. Analyse the requirements\n2. Design the schema\n3. Implement it");
    const reasoningNodes = c.getTree().filter((n) => n.type === "reasoning");
    expect(reasoningNodes.length).toBeGreaterThanOrEqual(3);
  });

  it("labels numbered nodes as 'Step N'", () => {
    const c = makeCollector();
    c.addFromLlmResponse("1. First thing to do\n2. Second thing to do");
    const stepNodes = c.getTree().filter((n) => n.label.startsWith("Step "));
    expect(stepNodes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ThoughtTreeCollector — conclusion markers → 'conclusion' nodes", () => {
  it("extracts 'In conclusion' as a 'conclusion' node", () => {
    const c = makeCollector();
    c.addFromLlmResponse("In conclusion, approach A is the best choice.");
    const conclusions = c.getTree().filter((n) => n.type === "conclusion");
    expect(conclusions.length).toBe(1);
    expect(conclusions[0].label).toBe("Conclusion");
  });

  it("extracts 'Therefore' as a 'conclusion' node", () => {
    const c = makeCollector();
    c.addFromLlmResponse("Therefore, we should use Redis for caching.");
    const conclusions = c.getTree().filter((n) => n.type === "conclusion");
    expect(conclusions.length).toBe(1);
  });

  it("extracts 'To summarize' as a 'conclusion' node", () => {
    const c = makeCollector();
    c.addFromLlmResponse("To summarize, option B wins on all criteria.");
    const conclusions = c.getTree().filter((n) => n.type === "conclusion");
    expect(conclusions.length).toBe(1);
  });

  it("links conclusion to a preceding branch node when available", () => {
    const c = makeCollector();
    c.addFromLlmResponse(
      "On one hand, approach A is fast. On the other hand, B is safer. Therefore, B is preferred."
    );
    const tree = c.getTree();
    const conclusion = tree.find((n) => n.type === "conclusion");
    const branches = tree.filter((n) => n.type === "branch");
    expect(conclusion).toBeDefined();
    expect(branches.length).toBeGreaterThan(0);
    // conclusion should link to a branch node
    const parentIsBranch = branches.some((b) => b.id === conclusion?.parentId);
    expect(parentIsBranch).toBe(true);
  });
});

// ─── Tool calls ───────────────────────────────────────────────────────────────

describe("ThoughtTreeCollector — tool calls", () => {
  it("addToolCall returns an ID and creates a tool_call node", () => {
    const c = makeCollector();
    const id = c.addToolCall("search", '{"query": "test"}');
    const tree = c.getTree();
    expect(tree.length).toBe(1);
    expect(tree[0].type).toBe("tool_call");
    expect(tree[0].id).toBe(id);
    expect(tree[0].metadata?.toolName).toBe("search");
  });

  it("addToolResult links result to preceding tool call via parentId", () => {
    const c = makeCollector();
    const callId = c.addToolCall("fetch", "{}");
    c.addToolResult(callId, "result data");
    const tree = c.getTree();
    const result = tree.find((n) => n.type === "tool_result");
    expect(result).toBeDefined();
    expect(result?.parentId).toBe(callId);
  });
});

// ─── Multiple calls accumulate ────────────────────────────────────────────────

describe("ThoughtTreeCollector — accumulation across calls", () => {
  it("accumulates nodes from multiple addFromLlmResponse calls", () => {
    const c = makeCollector();
    c.addFromLlmResponse("<thinking>First thought</thinking>");
    c.addFromLlmResponse("<thinking>Second thought</thinking>");
    expect(c.getTree().length).toBe(2);
  });

  it("serialize() returns valid JSON string", () => {
    const c = makeCollector();
    c.addFromLlmResponse("<thinking>A thought</thinking>");
    const json = c.serialize();
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].type).toBe("reasoning");
  });
});
