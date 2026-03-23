import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { K8sAgent } from "../src/agents/k8s-agent.js";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";

// ─── Mock child_process ─────────────────────────────────────────────────────

vi.mock("node:child_process", () => {
  const execFileFn = vi.fn();
  const spawnFn = vi.fn();
  return {
    execFile: execFileFn,
    spawn: spawnFn,
  };
});

const mockedExecFile = childProcess.execFile as unknown as ReturnType<typeof vi.fn>;
const mockedSpawn = childProcess.spawn as unknown as ReturnType<typeof vi.fn>;

function mockExecFileSuccess(stdout: string, stderr = "") {
  mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout, stderr });
  });
}

function mockExecFileError(message: string, stderr = "") {
  mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const err = new Error(message) as Error & { stderr: string };
    err.stderr = stderr;
    cb(err);
  });
}

function createMockSpawnProcess(stdout: string, exitCode = 0, stderr = "") {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };

  mockedSpawn.mockReturnValue(proc);

  // Schedule data and close events
  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  }, 5);

  return proc;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const PORT = 19900;
const BASE = `http://localhost:${PORT}`;

describe("K8sAgent", () => {
  let agent: K8sAgent;
  const origEnv = { ...process.env };

  beforeAll(async () => {
    process.env.AGENT_PORT = String(PORT);
    process.env.AGENT_NAMESPACE = "test-ns";
    agent = new K8sAgent();
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    process.env = origEnv;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Tool registration ──────────────────────────────────────────────────

  it("registers all 7 kubectl tools", async () => {
    const res = await fetch(`${BASE}/.well-known/agent.json`);
    const card = await res.json();
    expect(card.skills).toHaveLength(7);
    const names = card.skills.map((s: { id: string }) => s.id);
    expect(names).toEqual([
      "kubectl_get",
      "kubectl_apply",
      "kubectl_delete",
      "kubectl_logs",
      "kubectl_rollout_status",
      "kubectl_describe",
      "kubectl_exec",
    ]);
  });

  it("agent card has correct metadata", async () => {
    const res = await fetch(`${BASE}/.well-known/agent.json`);
    const card = await res.json();
    expect(card.name).toBe("k8s-agent");
    expect(card.version).toBe("0.1.0");
    expect(card.description).toContain("Kubernetes");
  });

  it("MCP endpoint lists all tools with schemas", async () => {
    const res = await fetch(`${BASE}/mcp`);
    const body = await res.json();
    expect(body.tools).toHaveLength(7);
    expect(body.tools[0].name).toBe("kubectl_get");
    expect(body.tools[0].inputSchema).toBeDefined();
    expect(body.tools[0].inputSchema.required).toContain("resource");
  });

  // ─── kubectl_get ────────────────────────────────────────────────────────

  it("kubectl_get builds correct args for basic resource fetch", async () => {
    mockExecFileSuccess('{"items":[]}');

    const res = await fetch(`${BASE}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: { parts: [{ text: "list pods" }] },
          skill: "kubectl_get",
        },
      }),
    });
    const rpc = await res.json();

    // The handler receives { input: "list pods" } when called via skill routing
    // but kubectl_get expects { resource: "..." }, so it will use input.resource
    // For direct tool invocation via A2A skill routing, the handler gets { input: text }
    expect(mockedExecFile).toHaveBeenCalled();
    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("kubectl");
    // First positional arg is "get"
    expect(callArgs[1][0]).toBe("get");
  });

  it("kubectl_get with resource, namespace, selector, and output builds all flags", async () => {
    mockExecFileSuccess('{"items":[{"metadata":{"name":"web"}}]}');

    // Access the tool directly through the tools map
    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_get")!;
    await tool.handler({ resource: "pods", namespace: "prod", selector: "app=web", output: "yaml" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("kubectl");
    expect(callArgs[1]).toEqual(["get", "pods", "-n", "prod", "-l", "app=web", "-o", "yaml"]);
  });

  it("kubectl_get with specific resource name", async () => {
    mockExecFileSuccess('{"metadata":{"name":"nginx"}}');

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_get")!;
    await tool.handler({ resource: "pod", name: "nginx-abc123" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["get", "pod", "nginx-abc123", "-n", "test-ns", "-o", "json"]);
  });

  // ─── kubectl_logs ───────────────────────────────────────────────────────

  it("kubectl_logs with tail and since flags", async () => {
    mockExecFileSuccess("log line 1\nlog line 2");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_logs")!;
    await tool.handler({ pod: "my-pod", tail: 100, since: "1h" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("kubectl");
    expect(callArgs[1]).toEqual(["logs", "my-pod", "-n", "test-ns", "--tail", "100", "--since", "1h"]);
  });

  it("kubectl_logs with container and previous flags", async () => {
    mockExecFileSuccess("previous log output");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_logs")!;
    await tool.handler({ pod: "my-pod", container: "sidecar", previous: true, namespace: "kube-system" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["logs", "my-pod", "-n", "kube-system", "-c", "sidecar", "--previous"]);
  });

  // ─── kubectl_apply ──────────────────────────────────────────────────────

  it("kubectl_apply passes manifest via stdin", async () => {
    const manifest = "apiVersion: v1\nkind: Pod\nmetadata:\n  name: test";
    createMockSpawnProcess('{"kind":"Pod"}', 0);

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_apply")!;
    const result = await tool.handler({ manifest });

    expect(mockedSpawn).toHaveBeenCalled();
    const spawnArgs = mockedSpawn.mock.calls[0];
    expect(spawnArgs[0]).toBe("kubectl");
    expect(spawnArgs[1]).toEqual(["apply", "-f", "-", "-n", "test-ns", "-o", "json"]);

    const proc = mockedSpawn.mock.results[0].value;
    expect(proc.stdin.write).toHaveBeenCalledWith(manifest);
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it("kubectl_apply with dry-run flag", async () => {
    createMockSpawnProcess('{"kind":"Pod"}', 0);

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_apply")!;
    await tool.handler({ manifest: "apiVersion: v1", dryRun: true, namespace: "staging" });

    const spawnArgs = mockedSpawn.mock.calls[0];
    expect(spawnArgs[1]).toEqual(["apply", "-f", "-", "-n", "staging", "--dry-run=client", "-o", "json"]);
  });

  // ─── kubectl_delete ─────────────────────────────────────────────────────

  it("kubectl_delete builds correct args", async () => {
    mockExecFileSuccess('pod "nginx" deleted');

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_delete")!;
    await tool.handler({ resource: "pod", name: "nginx" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["delete", "pod", "nginx", "-n", "test-ns"]);
  });

  // ─── kubectl_rollout_status ─────────────────────────────────────────────

  it("kubectl_rollout_status builds correct args with timeout", async () => {
    mockExecFileSuccess("deployment successfully rolled out");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_rollout_status")!;
    await tool.handler({ resource: "deployment/web", timeout: "120s" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["rollout", "status", "deployment/web", "-n", "test-ns", "--timeout", "120s"]);
  });

  // ─── kubectl_describe ───────────────────────────────────────────────────

  it("kubectl_describe builds correct args", async () => {
    mockExecFileSuccess("Name: nginx\nNamespace: test-ns\n...");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_describe")!;
    await tool.handler({ resource: "pod", name: "nginx" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["describe", "pod", "nginx", "-n", "test-ns"]);
  });

  // ─── kubectl_exec ──────────────────────────────────────────────────────

  it("kubectl_exec builds correct args with container", async () => {
    mockExecFileSuccess("uid=0(root)");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_exec")!;
    await tool.handler({ pod: "web-0", command: "id", container: "app" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["exec", "web-0", "-n", "test-ns", "-c", "app", "--", "sh", "-c", "id"]);
  });

  // ─── Error handling ─────────────────────────────────────────────────────

  it("exec returns error content on command failure", async () => {
    mockExecFileError("command not found", "kubectl: command not found");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_get")!;
    const result = await tool.handler({ resource: "pods" });

    expect(result.content).toContain("Error:");
    expect(result.content).toContain("kubectl: command not found");
  });

  it("execWithStdin returns error on non-zero exit code", async () => {
    createMockSpawnProcess("", 1, "error: invalid manifest");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_apply")!;
    const result = await tool.handler({ manifest: "invalid yaml" });

    expect(result.content).toContain("Error (exit 1)");
    expect(result.content).toContain("error: invalid manifest");
  });

  // ─── AGENT_NAMESPACE env var ────────────────────────────────────────────

  it("uses AGENT_NAMESPACE env var as default namespace", async () => {
    mockExecFileSuccess('{"items":[]}');

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_get")!;
    await tool.handler({ resource: "services" });

    const callArgs = mockedExecFile.mock.calls[0];
    // Should use "test-ns" from AGENT_NAMESPACE
    expect(callArgs[1]).toContain("test-ns");
    expect(callArgs[1]).toEqual(["get", "services", "-n", "test-ns", "-o", "json"]);
  });

  it("namespace parameter overrides AGENT_NAMESPACE", async () => {
    mockExecFileSuccess('{"items":[]}');

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("kubectl_get")!;
    await tool.handler({ resource: "pods", namespace: "custom-ns" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toContain("custom-ns");
    expect(callArgs[1]).not.toContain("test-ns");
  });
});
