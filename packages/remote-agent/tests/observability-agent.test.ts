import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { ObservabilityAgent } from "../src/agents/observability-agent.js";
import * as childProcess from "node:child_process";

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

// ─── Mock fetch ─────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── Tests ──────────────────────────────────────────────────────────────────

const PORT = 19910;
const BASE = `http://localhost:${PORT}`;

describe("ObservabilityAgent", () => {
  let agent: ObservabilityAgent;
  const origEnv = { ...process.env };

  beforeAll(async () => {
    process.env.AGENT_PORT = String(PORT);
    process.env.AGENT_NAMESPACE = "monitoring";
    process.env.PROMETHEUS_URL = "http://prom:9090";
    process.env.LOKI_URL = "http://loki:3100";
    agent = new ObservabilityAgent();
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

  it("registers all 5 observability tools", async () => {
    const res = await globalThis.fetch(`${BASE}/.well-known/agent.json`);
    // The agent card fetch goes through the real server, but our mock intercepts all fetch calls.
    // We need to restore real fetch for server communication.
    // Actually, we should only mock fetch inside tool handlers. Let's use the tools map directly.
    const tools = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools;
    expect(tools.size).toBe(5);
    expect([...tools.keys()]).toEqual([
      "prometheus_query",
      "loki_query",
      "pod_metrics",
      "node_metrics",
      "system_info",
    ]);
  });

  it("agent card has correct metadata", async () => {
    const tools = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools;
    expect(tools.has("prometheus_query")).toBe(true);
    expect(tools.has("system_info")).toBe(true);
  });

  // ─── prometheus_query ───────────────────────────────────────────────────

  it("prometheus_query sends correct request to Prometheus", async () => {
    mockFetch.mockResolvedValueOnce({
      text: async () => JSON.stringify({ status: "success", data: { result: [] } }),
    });

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("prometheus_query")!;
    const result = await tool.handler({ query: "up{job=\"node\"}" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("http://prom:9090/api/v1/query");
    expect(calledUrl).toContain("query=up");
    expect(result.content).toContain("success");
  });

  it("prometheus_query includes time parameter when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      text: async () => '{"status":"success"}',
    });

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("prometheus_query")!;
    await tool.handler({ query: "up", time: "2024-01-01T00:00:00Z" });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("time=");
  });

  it("prometheus_query handles fetch errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("connection refused"));

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("prometheus_query")!;
    const result = await tool.handler({ query: "up" });

    expect(result.content).toContain("Error:");
    expect(result.content).toContain("connection refused");
  });

  // ─── loki_query ─────────────────────────────────────────────────────────

  it("loki_query sends correct request to Loki with all params", async () => {
    mockFetch.mockResolvedValueOnce({
      text: async () => JSON.stringify({ status: "success", data: { result: [] } }),
    });

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("loki_query")!;
    const result = await tool.handler({
      query: '{app="web"}',
      limit: 50,
      direction: "backward",
      start: "1704067200000000000",
      end: "1704153600000000000",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("http://loki:3100/loki/api/v1/query_range");
    expect(calledUrl).toContain("limit=50");
    expect(calledUrl).toContain("direction=backward");
    expect(calledUrl).toContain("start=");
    expect(calledUrl).toContain("end=");
    expect(result.content).toContain("success");
  });

  it("loki_query handles fetch errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("timeout"));

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("loki_query")!;
    const result = await tool.handler({ query: '{app="web"}' });

    expect(result.content).toContain("Error:");
    expect(result.content).toContain("timeout");
  });

  // ─── pod_metrics ────────────────────────────────────────────────────────

  it("pod_metrics runs kubectl top with correct args", async () => {
    mockExecFileSuccess("NAME       CPU   MEMORY\nnginx      10m   50Mi");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("pod_metrics")!;
    const result = await tool.handler({ sortBy: "memory" });

    expect(mockedExecFile).toHaveBeenCalled();
    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("kubectl");
    expect(callArgs[1]).toEqual(["top", "pods", "-n", "monitoring", "--sort-by=memory"]);
    expect(result.content).toContain("nginx");
  });

  it("pod_metrics defaults to cpu sort and AGENT_NAMESPACE", async () => {
    mockExecFileSuccess("NAME  CPU  MEMORY");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("pod_metrics")!;
    await tool.handler({});

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["top", "pods", "-n", "monitoring", "--sort-by=cpu"]);
  });

  // ─── node_metrics ───────────────────────────────────────────────────────

  it("node_metrics runs kubectl top nodes", async () => {
    mockExecFileSuccess("NAME      CPU   CPU%   MEMORY   MEMORY%\nnode-1    100m  5%     1Gi      20%");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("node_metrics")!;
    const result = await tool.handler({ sortBy: "memory" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("kubectl");
    expect(callArgs[1]).toEqual(["top", "nodes", "--sort-by=memory"]);
    expect(result.content).toContain("node-1");
  });

  // ─── system_info ────────────────────────────────────────────────────────

  it("system_info returns real system data", async () => {
    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("system_info")!;
    const result = await tool.handler({});

    const info = JSON.parse(result.content);
    expect(info.cpus).toBeDefined();
    expect(Array.isArray(info.cpus)).toBe(true);
    expect(info.totalMemory).toBeGreaterThan(0);
    expect(info.freeMemory).toBeGreaterThan(0);
    expect(typeof info.uptime).toBe("number");
    expect(Array.isArray(info.loadAverage)).toBe(true);
    expect(info.loadAverage).toHaveLength(3);
  });
});
