/**
 * Unit tests for server/pipeline/thought-tree-collector.ts
 *
 * Tests collection order, tree structure, parsing logic, and edge cases.
 * No external dependencies or LLM calls.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ThoughtTreeCollector } from "../../../server/pipeline/thought-tree-collector.js";
import type { ThoughtTree, ThoughtNode } from "../../../shared/types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCollector(): ThoughtTreeCollector {
  return new ThoughtTreeCollector();
}

// ─── Initial state ────────────────────────────────────────────────────────────

describe("ThoughtTreeCollector — initial state", () => {
  it("getTree returns empty array before any additions", () => {
    const collector = makeCollector();
    const tree: ThoughtTree = collector.getTree();
    expect(tree).toEqual([]);
  });

  it("serialize returns '[]' for empty collector", () => {
    const collector = makeCollector();
    expect(collector.serialize()).toBe("[]");
  });
});

// ─── addFromLlmResponse — thinking blocks ────────────────────────────────────

describe("ThoughtTreeCollector.addFromLlmResponse — <thinking> extraction", () => {
  it("extracts a single <thinking> block as a reasoning node", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("<thinking>I need to analyze this carefully</thinking>");
    const tree = collector.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe("reasoning");
  });

  it("extracts <thinking> content correctly", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("<thinking>step by step reasoning here</thinking>");
    expect(collector.getTree()[0].content).toBe("step by step reasoning here");
  });

  it("sets label to 'Thinking' for thinking blocks", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("<thinking>reason</thinking>");
    expect(collector.getTree()[0].label).toBe("Thinking");
  });

  it("extracts multiple <thinking> blocks in order", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse(
      "<thinking>first thought</thinking> text <thinking>second thought</thinking>",
    );
    const tree = collector.getTree();
    const thoughts = tree.filter((n) => n.type === "reasoning" && n.label === "Thinking");
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0].content).toBe("first thought");
    expect(thoughts[1].content).toBe("second thought");
  });

  it("attaches model metadata when model is provided", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("<thinking>reasoning</thinking>", "gpt-4");
    const node = collector.getTree()[0];
    expect(node.metadata?.model).toBe("gpt-4");
  });

  it("sets metadata to undefined when no model is given", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("<thinking>reasoning</thinking>");
    const node = collector.getTree()[0];
    expect(node.metadata).toBeUndefined();
  });

  it("ignores empty <thinking> blocks (creates fallback Response node for non-empty input)", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("<thinking></thinking>");
    // The thinking content is empty so no thinking node is created.
    // The full input string is non-empty, so the fallback "Response" node fires.
    const tree = collector.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("Response");
  });
});

// ─── addFromLlmResponse — Step headings ──────────────────────────────────────

describe("ThoughtTreeCollector.addFromLlmResponse — ## Step headings", () => {
  it("extracts ## Step N: heading as a reasoning node", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("## Step 1: Analyze requirements\nDetails here.");
    const tree = collector.getTree();
    expect(tree.some((n) => n.type === "reasoning")).toBe(true);
  });

  it("uses the heading title as the node label", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("## Step 1: Analyze requirements\nDetails here.");
    const node = collector.getTree().find((n) => n.label === "Analyze requirements");
    expect(node).toBeDefined();
  });

  it("captures content after heading until next heading", () => {
    const collector = makeCollector();
    const content = "## Step 1: First step\nFirst content.\n## Step 2: Second step\nSecond content.";
    collector.addFromLlmResponse(content);
    const nodes = collector.getTree().filter((n) => n.type === "reasoning");
    const first = nodes.find((n) => n.label === "First step");
    expect(first?.content).toContain("First content");
  });

  it("supports # and ### headings as well as ##", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("### Step 2: Do something\nContent.");
    const tree = collector.getTree();
    expect(tree.some((n) => n.label === "Do something")).toBe(true);
  });
});

// ─── addFromLlmResponse — Decision lines ─────────────────────────────────────

describe("ThoughtTreeCollector.addFromLlmResponse — Decision lines", () => {
  it("extracts 'Decision:' line as a decision node", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("Decision: Use PostgreSQL for storage");
    const tree = collector.getTree();
    expect(tree.some((n) => n.type === "decision")).toBe(true);
  });

  it("captures decision content correctly", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("Decision: Use PostgreSQL for storage");
    const node = collector.getTree().find((n) => n.type === "decision");
    expect(node?.content).toBe("Use PostgreSQL for storage");
  });

  it("extracts 'Final Decision:' line as a decision node", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("Final Decision: Go with microservices");
    const tree = collector.getTree();
    expect(tree.some((n) => n.type === "decision")).toBe(true);
  });

  it("sets metadata.decision on decision nodes", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("Decision: use Redis");
    const node = collector.getTree().find((n) => n.type === "decision");
    expect(node?.metadata?.decision).toBe("use Redis");
  });
});

// ─── addFromLlmResponse — Fallback node ──────────────────────────────────────

describe("ThoughtTreeCollector.addFromLlmResponse — fallback node", () => {
  it("adds a single reasoning node when no structured content is detected", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("Here is a plain response with no markers.");
    const tree = collector.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].type).toBe("reasoning");
    expect(tree[0].label).toBe("Response");
  });

  it("truncates long plain content to 120 chars + ellipsis", () => {
    const collector = makeCollector();
    const longText = "a".repeat(200);
    collector.addFromLlmResponse(longText);
    const node = collector.getTree()[0];
    expect(node.content.length).toBeLessThanOrEqual(124); // 120 + "…" length
  });

  it("does not add fallback node for empty content", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("   ");
    expect(collector.getTree()).toHaveLength(0);
  });
});

// ─── addDecision ─────────────────────────────────────────────────────────────

describe("ThoughtTreeCollector.addDecision", () => {
  it("adds a decision node with correct type", () => {
    const collector = makeCollector();
    collector.addDecision("Architecture Decision", "Use microservices");
    const node = collector.getTree()[0];
    expect(node.type).toBe("decision");
  });

  it("sets node label correctly", () => {
    const collector = makeCollector();
    collector.addDecision("My Decision", "some content");
    expect(collector.getTree()[0].label).toBe("My Decision");
  });

  it("sets node content correctly", () => {
    const collector = makeCollector();
    collector.addDecision("Label", "the actual decision content");
    expect(collector.getTree()[0].content).toBe("the actual decision content");
  });

  it("sets metadata.decision to the content", () => {
    const collector = makeCollector();
    collector.addDecision("D", "decision text");
    expect(collector.getTree()[0].metadata?.decision).toBe("decision text");
  });

  it("node has a non-null id (UUID)", () => {
    const collector = makeCollector();
    collector.addDecision("D", "c");
    expect(typeof collector.getTree()[0].id).toBe("string");
    expect(collector.getTree()[0].id.length).toBeGreaterThan(0);
  });

  it("node has null parentId", () => {
    const collector = makeCollector();
    collector.addDecision("D", "c");
    expect(collector.getTree()[0].parentId).toBeNull();
  });
});

// ─── addToolCall ──────────────────────────────────────────────────────────────

describe("ThoughtTreeCollector.addToolCall", () => {
  it("adds a tool_call node", () => {
    const collector = makeCollector();
    collector.addToolCall("web_search", '{"query":"typescript"}');
    const node = collector.getTree()[0];
    expect(node.type).toBe("tool_call");
  });

  it("label includes the tool name", () => {
    const collector = makeCollector();
    collector.addToolCall("web_search", "{}");
    expect(collector.getTree()[0].label).toContain("web_search");
  });

  it("content is the args string", () => {
    const collector = makeCollector();
    collector.addToolCall("web_search", '{"query":"test"}');
    expect(collector.getTree()[0].content).toBe('{"query":"test"}');
  });

  it("returns a string id that can be used as parentId", () => {
    const collector = makeCollector();
    const id = collector.addToolCall("web_search", "{}");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("metadata.toolName is set correctly", () => {
    const collector = makeCollector();
    collector.addToolCall("knowledge_search", "{}");
    expect(collector.getTree()[0].metadata?.toolName).toBe("knowledge_search");
  });
});

// ─── addToolResult ────────────────────────────────────────────────────────────

describe("ThoughtTreeCollector.addToolResult", () => {
  it("adds a tool_result node", () => {
    const collector = makeCollector();
    const callId = collector.addToolCall("web_search", "{}");
    collector.addToolResult(callId, "search results here");
    const resultNode = collector.getTree().find((n) => n.type === "tool_result");
    expect(resultNode).toBeDefined();
  });

  it("links result to the parent tool call via parentId", () => {
    const collector = makeCollector();
    const callId = collector.addToolCall("web_search", "{}");
    collector.addToolResult(callId, "results");
    const resultNode = collector.getTree().find((n) => n.type === "tool_result");
    expect(resultNode?.parentId).toBe(callId);
  });

  it("sets correct content on tool result node", () => {
    const collector = makeCollector();
    const callId = collector.addToolCall("web_search", "{}");
    collector.addToolResult(callId, "the result text");
    const resultNode = collector.getTree().find((n) => n.type === "tool_result");
    expect(resultNode?.content).toBe("the result text");
  });

  it("label is 'Tool Result'", () => {
    const collector = makeCollector();
    const callId = collector.addToolCall("web_search", "{}");
    collector.addToolResult(callId, "r");
    const node = collector.getTree().find((n) => n.type === "tool_result");
    expect(node?.label).toBe("Tool Result");
  });
});

// ─── Collection order ─────────────────────────────────────────────────────────

describe("ThoughtTreeCollector — collection order", () => {
  it("preserves insertion order of nodes", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("<thinking>thought one</thinking>");
    collector.addDecision("Dec", "decision content");
    collector.addToolCall("tool_a", "{}");
    const tree = collector.getTree();
    expect(tree[0].type).toBe("reasoning");
    expect(tree[1].type).toBe("decision");
    expect(tree[2].type).toBe("tool_call");
  });

  it("accumulates nodes across multiple addFromLlmResponse calls", () => {
    const collector = makeCollector();
    collector.addFromLlmResponse("<thinking>one</thinking>");
    collector.addFromLlmResponse("<thinking>two</thinking>");
    expect(collector.getTree()).toHaveLength(2);
  });

  it("getTree returns all nodes including from mixed sources", () => {
    const collector = makeCollector();
    collector.addDecision("D1", "c1");
    collector.addToolCall("t1", "a1");
    collector.addDecision("D2", "c2");
    expect(collector.getTree()).toHaveLength(3);
  });
});

// ─── ThoughtNode shape ────────────────────────────────────────────────────────

describe("ThoughtTreeCollector — node shape", () => {
  it("every node has id, parentId, type, label, content, timestamp", () => {
    const collector = makeCollector();
    collector.addDecision("D", "c");
    const node = collector.getTree()[0];
    expect(node).toHaveProperty("id");
    expect(node).toHaveProperty("parentId");
    expect(node).toHaveProperty("type");
    expect(node).toHaveProperty("label");
    expect(node).toHaveProperty("content");
    expect(node).toHaveProperty("timestamp");
  });

  it("timestamp is a positive number", () => {
    const collector = makeCollector();
    collector.addDecision("D", "c");
    expect(typeof collector.getTree()[0].timestamp).toBe("number");
    expect(collector.getTree()[0].timestamp).toBeGreaterThan(0);
  });

  it("each node gets a unique id even when added in rapid succession", () => {
    const collector = makeCollector();
    collector.addDecision("A", "a");
    collector.addDecision("B", "b");
    const ids = collector.getTree().map((n: ThoughtNode) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── serialize ────────────────────────────────────────────────────────────────

describe("ThoughtTreeCollector.serialize", () => {
  it("returns a valid JSON string", () => {
    const collector = makeCollector();
    collector.addDecision("D", "c");
    expect(() => JSON.parse(collector.serialize())).not.toThrow();
  });

  it("serialized JSON contains the added node", () => {
    const collector = makeCollector();
    collector.addDecision("TestLabel", "test content");
    const parsed = JSON.parse(collector.serialize()) as ThoughtNode[];
    expect(parsed.some((n) => n.label === "TestLabel")).toBe(true);
  });
});
