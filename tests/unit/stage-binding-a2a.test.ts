/**
 * Tests for pipeline stage connection binding, RBAC scoping,
 * and inter-stage A2A messaging (issue #269).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  filterToolsByAllowedConnections,
  checkToolAllowed,
  emitConnectionBlockedEvent,
  getConnectionIdFromTool,
  CONNECTION_TAG_PREFIX,
} from "../../server/pipeline/connection-scope";

import {
  A2AMessagingService,
  A2ARateLimiter,
  A2ARateLimitExceededError,
  redactSecrets,
  DEFAULT_A2A_TIMEOUT_MS,
  DEFAULT_MAX_CLARIFY_PER_STAGE,
} from "../../server/pipeline/a2a-messaging";

import type { ToolDefinition } from "../../shared/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTool(name: string, connectionId?: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {},
    source: connectionId ? "mcp" : "builtin",
    tags: connectionId ? [`${CONNECTION_TAG_PREFIX}${connectionId}`] : [],
  };
}

function makeWsManager() {
  const broadcasts: Array<{ runId: string; event: unknown }> = [];
  return {
    broadcastToRun: vi.fn((runId: string, event: unknown) => {
      broadcasts.push({ runId, event });
    }),
    getBroadcasts: () => broadcasts,
  };
}

// ─── connection-scope tests ───────────────────────────────────────────────────

describe("getConnectionIdFromTool", () => {
  it("returns undefined for tools with no connection tag", () => {
    const tool = makeTool("run_code");
    expect(getConnectionIdFromTool(tool)).toBeUndefined();
  });

  it("returns the connection ID from the tag", () => {
    const tool = makeTool("list_repos", "conn-github-1");
    expect(getConnectionIdFromTool(tool)).toBe("conn-github-1");
  });

  it("returns undefined when tags array is empty", () => {
    const tool: ToolDefinition = { name: "x", description: "", inputSchema: {}, source: "builtin", tags: [] };
    expect(getConnectionIdFromTool(tool)).toBeUndefined();
  });

  it("returns undefined when tags is undefined", () => {
    const tool: ToolDefinition = { name: "x", description: "", inputSchema: {}, source: "builtin" };
    expect(getConnectionIdFromTool(tool)).toBeUndefined();
  });
});

describe("filterToolsByAllowedConnections — default deny-all", () => {
  const builtinTool = makeTool("run_code");
  const githubTool = makeTool("list_repos", "conn-github-1");
  const k8sTool = makeTool("get_pods", "conn-k8s-2");

  it("allows builtin tools when allowedConnections is empty array (deny-all)", () => {
    const result = filterToolsByAllowedConnections([builtinTool, githubTool, k8sTool], []);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("run_code");
  });

  it("allows builtin tools when allowedConnections is undefined (deny-all)", () => {
    const result = filterToolsByAllowedConnections([builtinTool, githubTool], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("run_code");
  });

  it("allows only the explicitly permitted connection's tools", () => {
    const result = filterToolsByAllowedConnections(
      [builtinTool, githubTool, k8sTool],
      ["conn-github-1"],
    );
    expect(result.map((t) => t.name)).toEqual(["run_code", "list_repos"]);
  });

  it("allows both connections when both are listed", () => {
    const result = filterToolsByAllowedConnections(
      [builtinTool, githubTool, k8sTool],
      ["conn-github-1", "conn-k8s-2"],
    );
    expect(result.map((t) => t.name)).toEqual(["run_code", "list_repos", "get_pods"]);
  });

  it("does not expose tools for connections not in the allow-list", () => {
    const result = filterToolsByAllowedConnections(
      [githubTool, k8sTool],
      ["conn-github-1"],
    );
    expect(result.map((t) => t.name)).not.toContain("get_pods");
  });

  it("returns empty when all tools are connection-scoped and list is empty", () => {
    const result = filterToolsByAllowedConnections([githubTool, k8sTool], []);
    expect(result).toHaveLength(0);
  });
});

describe("checkToolAllowed", () => {
  const tools = [makeTool("run_code"), makeTool("list_repos", "conn-gh")];

  it("returns null for a builtin tool regardless of allow-list", () => {
    const err = checkToolAllowed("run_code", tools, [], "stage-1", "run-1");
    expect(err).toBeNull();
  });

  it("returns null when the tool's connection is allowed", () => {
    const err = checkToolAllowed("list_repos", tools, ["conn-gh"], "stage-1", "run-1");
    expect(err).toBeNull();
  });

  it("returns a ConnectionBlockedError when connection not in allow-list", () => {
    const err = checkToolAllowed("list_repos", tools, [], "stage-1", "run-1");
    expect(err).not.toBeNull();
    expect(err!.code).toBe("CONNECTION_BLOCKED");
    expect(err!.connectionId).toBe("conn-gh");
    expect(err!.stageId).toBe("stage-1");
    expect(err!.runId).toBe("run-1");
    expect(err!.message).toContain("conn-gh");
  });

  it("returns null for unknown tool names (registry will handle 'not found')", () => {
    const err = checkToolAllowed("nonexistent_tool", tools, [], "s", "r");
    expect(err).toBeNull();
  });
});

describe("emitConnectionBlockedEvent", () => {
  it("broadcasts stage:connection:blocked event with structured payload", () => {
    const ws = makeWsManager();
    emitConnectionBlockedEvent(ws as never, "run-42", "exec-9", {
      code: "CONNECTION_BLOCKED",
      connectionId: "conn-aws",
      stageId: "stage-2",
      runId: "run-42",
      message: "Tool disallowed",
    });

    expect(ws.broadcastToRun).toHaveBeenCalledOnce();
    const [runId, event] = (ws.broadcastToRun as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
    expect(runId).toBe("run-42");
    expect(event.type).toBe("stage:connection:blocked");
    expect((event.payload as Record<string, unknown>).connectionId).toBe("conn-aws");
  });
});

// ─── a2a-messaging tests ─────────────────────────────────────────────────────

describe("redactSecrets", () => {
  it("redacts password=value patterns", () => {
    const result = redactSecrets("Using password=supersecret123 in request");
    expect(result).not.toContain("supersecret123");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts api_key patterns", () => {
    const result = redactSecrets("api_key=sk-abc12345xyz");
    expect(result).not.toContain("sk-abc12345xyz");
  });

  it("redacts token patterns", () => {
    const result = redactSecrets("Bearer token=my.jwt.token");
    expect(result).not.toContain("my.jwt.token");
  });

  it("does not alter text without secrets", () => {
    const clean = "Check if deployment is healthy";
    expect(redactSecrets(clean)).toBe(clean);
  });

  it("redacts AWS key IDs", () => {
    const result = redactSecrets("Access key: AKIAIOSFODNN7EXAMPLE");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("A2ARateLimiter", () => {
  it("starts at zero", () => {
    const rl = new A2ARateLimiter();
    expect(rl.getCount("run-1", "stage-A")).toBe(0);
  });

  it("increments correctly", () => {
    const rl = new A2ARateLimiter();
    expect(rl.increment("run-1", "stage-A")).toBe(1);
    expect(rl.increment("run-1", "stage-A")).toBe(2);
    expect(rl.getCount("run-1", "stage-A")).toBe(2);
  });

  it("tracks different stages independently", () => {
    const rl = new A2ARateLimiter();
    rl.increment("run-1", "stage-A");
    rl.increment("run-1", "stage-B");
    rl.increment("run-1", "stage-B");
    expect(rl.getCount("run-1", "stage-A")).toBe(1);
    expect(rl.getCount("run-1", "stage-B")).toBe(2);
  });

  it("clearRun removes all counts for a run", () => {
    const rl = new A2ARateLimiter();
    rl.increment("run-1", "stage-A");
    rl.increment("run-1", "stage-B");
    rl.increment("run-2", "stage-A");
    rl.clearRun("run-1");
    expect(rl.getCount("run-1", "stage-A")).toBe(0);
    expect(rl.getCount("run-1", "stage-B")).toBe(0);
    expect(rl.getCount("run-2", "stage-A")).toBe(1); // unaffected
  });
});

describe("A2AMessagingService — happy path (stage A clarifies stage B, B answers)", () => {
  it("resolves with the answer text when handleAnswer is called before timeout", async () => {
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 10_000);

    const clarifyPromise = svc.clarify("run-1", "stage-A", "stage-B", "What is the schema?");

    // Simulate stage B answering — extract clarifyId from broadcast
    const broadcasts = ws.getBroadcasts();
    const clarifyEvent = broadcasts.find(
      (b) => (b.event as Record<string, unknown>).type === "stage:a2a:clarify",
    );
    expect(clarifyEvent).toBeDefined();
    const clarifyId = ((clarifyEvent!.event as Record<string, unknown>).payload as Record<string, unknown>).id as string;

    svc.handleAnswer("run-1", clarifyId, "stage-A", "stage-B", "The schema is JSON.");

    const answer = await clarifyPromise;
    expect(answer).toBe("The schema is JSON.");
  });

  it("emits stage:a2a:clarify WS event when sending", async () => {
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 10_000);

    const p = svc.clarify("run-1", "stage-A", "stage-B", "Hello?");
    const clarifyBroadcast = ws.getBroadcasts().find(
      (b) => (b.event as Record<string, unknown>).type === "stage:a2a:clarify",
    );
    expect(clarifyBroadcast).toBeDefined();

    // Clean up
    const clarifyId = ((clarifyBroadcast!.event as Record<string, unknown>).payload as Record<string, unknown>).id as string;
    svc.handleAnswer("run-1", clarifyId, "stage-A", "stage-B", "ok");
    await p;
  });

  it("emits stage:a2a:answer WS event when answered", async () => {
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 10_000);

    const p = svc.clarify("run-1", "stage-X", "stage-Y", "Context?");
    const clarifyId = (((ws.getBroadcasts()[0].event) as Record<string, unknown>).payload as Record<string, unknown>).id as string;
    svc.handleAnswer("run-1", clarifyId, "stage-X", "stage-Y", "Here you go");
    await p;

    const answerBroadcast = ws.getBroadcasts().find(
      (b) => (b.event as Record<string, unknown>).type === "stage:a2a:answer",
    );
    expect(answerBroadcast).toBeDefined();
    expect(
      ((answerBroadcast!.event as Record<string, unknown>).payload as Record<string, unknown>).answer,
    ).toBe("Here you go");
  });

  it("records entries in the thread", async () => {
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 10_000);

    const p = svc.clarify("run-1", "stage-A", "stage-B", "What is X?");
    const clarifyId = (((ws.getBroadcasts()[0].event) as Record<string, unknown>).payload as Record<string, unknown>).id as string;
    svc.handleAnswer("run-1", clarifyId, "stage-A", "stage-B", "X is 42");
    await p;

    const thread = svc.getThread("run-1");
    expect(thread.length).toBe(2); // clarify + answer
    expect(thread[0].type).toBe("clarify");
    expect(thread[1].type).toBe("answer");
  });
});

describe("A2AMessagingService — timeout scenario", () => {
  it("resolves with null and emits timeout event after timeout elapses", async () => {
    vi.useFakeTimers();
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 200);

    const resultPromise = svc.clarify("run-1", "stage-A", "stage-B", "Quick question");

    // Advance time past timeout
    await vi.advanceTimersByTimeAsync(201);

    const result = await resultPromise;
    expect(result).toBeNull();

    const timeoutEvent = ws.getBroadcasts().find(
      (b) => (b.event as Record<string, unknown>).type === "stage:a2a:timeout",
    );
    expect(timeoutEvent).toBeDefined();

    vi.useRealTimers();
  });

  it("records a timeout entry in the thread", async () => {
    vi.useFakeTimers();
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 100);

    const p = svc.clarify("run-1", "stage-A", "stage-B", "Will timeout");
    await vi.advanceTimersByTimeAsync(101);
    await p;

    const thread = svc.getThread("run-1");
    const timeoutEntry = thread.find((e) => e.type === "timeout");
    expect(timeoutEntry).toBeDefined();

    vi.useRealTimers();
  });

  it("does not answer after timeout (handleAnswer is a no-op)", async () => {
    vi.useFakeTimers();
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 100);

    const p = svc.clarify("run-1", "stage-A", "stage-B", "Late answer test");
    const clarifyId = (((ws.getBroadcasts()[0].event) as Record<string, unknown>).payload as Record<string, unknown>).id as string;
    await vi.advanceTimersByTimeAsync(101);
    await p;

    // Now try to answer — should be a no-op
    svc.handleAnswer("run-1", clarifyId, "stage-A", "stage-B", "Too late");
    const thread = svc.getThread("run-1");
    const answerEntry = thread.find((e) => e.type === "answer");
    expect(answerEntry).toBeUndefined();

    vi.useRealTimers();
  });
});

describe("A2AMessagingService — rate limiting", () => {
  it("throws A2ARateLimitExceededError when max messages exceeded", async () => {
    const ws = makeWsManager();
    const maxClarify = 3;
    const svc = new A2AMessagingService(ws as never, maxClarify, 60_000);

    const pending: Promise<string | null>[] = [];

    for (let i = 0; i < maxClarify; i++) {
      pending.push(svc.clarify("run-1", "stage-A", "stage-B", `Q${i}`));
    }

    // The (maxClarify + 1)-th call should throw
    await expect(
      svc.clarify("run-1", "stage-A", "stage-B", "One too many"),
    ).rejects.toThrow(A2ARateLimitExceededError);

    // Clean up pending promises
    const broadcasts = ws.getBroadcasts().filter(
      (b) => (b.event as Record<string, unknown>).type === "stage:a2a:clarify",
    );
    for (const b of broadcasts) {
      const id = ((b.event as Record<string, unknown>).payload as Record<string, unknown>).id as string;
      svc.handleAnswer("run-1", id, "stage-A", "stage-B", "ok");
    }
    await Promise.all(pending);
  });

  it("rate limits are per stage — different stages have separate limits", async () => {
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 1, 60_000);

    // stage-A uses its one slot
    const p1 = svc.clarify("run-1", "stage-A", "stage-B", "Q from A");
    // stage-C has its own fresh limit slot
    const p2 = svc.clarify("run-1", "stage-C", "stage-B", "Q from C");

    const broadcasts = ws.getBroadcasts().filter(
      (b) => (b.event as Record<string, unknown>).type === "stage:a2a:clarify",
    );
    expect(broadcasts.length).toBe(2);

    for (const b of broadcasts) {
      const payload = (b.event as Record<string, unknown>).payload as Record<string, unknown>;
      svc.handleAnswer("run-1", payload.id as string, payload.fromStageId as string, payload.targetStageId as string, "ok");
    }
    await Promise.all([p1, p2]);
  });
});

describe("A2AMessagingService — secret redaction in messages", () => {
  it("redacts secrets in the question before broadcast", async () => {
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 60_000);

    const p = svc.clarify(
      "run-1",
      "stage-A",
      "stage-B",
      "Please use password=topSecretPassw0rd to authenticate",
    );

    const clarifyBroadcast = ws.getBroadcasts().find(
      (b) => (b.event as Record<string, unknown>).type === "stage:a2a:clarify",
    );
    const broadcastQuestion = (
      (clarifyBroadcast!.event as Record<string, unknown>).payload as Record<string, unknown>
    ).question as string;
    expect(broadcastQuestion).not.toContain("topSecretPassw0rd");
    expect(broadcastQuestion).toContain("[REDACTED]");

    // Clean up
    const clarifyId = ((clarifyBroadcast!.event as Record<string, unknown>).payload as Record<string, unknown>).id as string;
    svc.handleAnswer("run-1", clarifyId, "stage-A", "stage-B", "sure");
    await p;
  });

  it("redacts secrets in the answer before broadcast", async () => {
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 60_000);

    const p = svc.clarify("run-1", "stage-A", "stage-B", "What?");
    const clarifyId = (
      (ws.getBroadcasts()[0].event as Record<string, unknown>).payload as Record<string, unknown>
    ).id as string;

    svc.handleAnswer(
      "run-1",
      clarifyId,
      "stage-A",
      "stage-B",
      "Use token=AKIA1234567890ABCDEF to access AWS",
    );
    await p;

    const answerBroadcast = ws.getBroadcasts().find(
      (b) => (b.event as Record<string, unknown>).type === "stage:a2a:answer",
    );
    const broadcastAnswer = (
      (answerBroadcast!.event as Record<string, unknown>).payload as Record<string, unknown>
    ).answer as string;
    expect(broadcastAnswer).not.toContain("AKIA1234567890ABCDEF");
    expect(broadcastAnswer).toContain("[REDACTED]");
  });
});

describe("A2AMessagingService — clearRun", () => {
  it("clears the thread for the run", async () => {
    const ws = makeWsManager();
    const svc = new A2AMessagingService(ws as never, 5, 60_000);

    const p = svc.clarify("run-1", "stage-A", "stage-B", "Q?");
    const clarifyId = (
      (ws.getBroadcasts()[0].event as Record<string, unknown>).payload as Record<string, unknown>
    ).id as string;
    svc.handleAnswer("run-1", clarifyId, "stage-A", "stage-B", "A!");
    await p;

    expect(svc.getThread("run-1").length).toBeGreaterThan(0);
    svc.clearRun("run-1");
    expect(svc.getThread("run-1").length).toBe(0);
  });
});
