import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { TriageAgent } from "../src/agents/triage-agent.js";
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

/** Mock exec that succeeds for specific call indices, fails for others. */
function mockExecFileMixed(results: Array<{ stdout?: string; error?: string }>) {
  let callIndex = 0;
  mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const result = results[callIndex] ?? { stdout: "" };
    callIndex++;
    if (result.error) {
      const err = new Error(result.error) as Error & { stderr: string };
      err.stderr = result.error;
      cb(err);
    } else {
      cb(null, { stdout: result.stdout ?? "", stderr: "" });
    }
  });
}

// ─── Mock fetch for check_endpoints ─────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── Tests ──────────────────────────────────────────────────────────────────

const PORT = 19920;

describe("TriageAgent", () => {
  let agent: TriageAgent;
  const origEnv = { ...process.env };

  beforeAll(async () => {
    process.env.AGENT_PORT = String(PORT);
    process.env.AGENT_NAMESPACE = "test-ns";
    agent = new TriageAgent();
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

  it("registers all 4 triage tools", () => {
    const tools = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools;
    expect(tools.size).toBe(4);
    expect([...tools.keys()]).toEqual([
      "triage_pod",
      "triage_deployment",
      "triage_node",
      "check_endpoints",
    ]);
  });

  // ─── triage_pod ─────────────────────────────────────────────────────────

  it("triage_pod collects all 4 sections on success", async () => {
    mockExecFileMixed([
      { stdout: "Name: nginx\nStatus: Running" },
      { stdout: "log line 1\nlog line 2" },
      { stdout: "previous log line" },
      { stdout: "LAST SEEN   TYPE   REASON   OBJECT   MESSAGE" },
    ]);

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("triage_pod")!;
    const result = await tool.handler({ pod: "nginx-abc", namespace: "prod" });

    expect(result.content).toContain("=== DESCRIBE POD ===");
    expect(result.content).toContain("=== LOGS (last 100) ===");
    expect(result.content).toContain("=== PREVIOUS LOGS ===");
    expect(result.content).toContain("=== EVENTS ===");
    expect(result.content).toContain("Name: nginx");
    expect(result.content).toContain("log line 1");
  });

  it("triage_pod tolerates individual command failures", async () => {
    mockExecFileMixed([
      { stdout: "Name: nginx" },
      { error: "container not found" },
      { error: "previous terminated container not found" },
      { stdout: "no events" },
    ]);

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("triage_pod")!;
    const result = await tool.handler({ pod: "nginx-abc" });

    // Should NOT throw; should contain all sections even with errors
    expect(result.content).toContain("=== DESCRIBE POD ===");
    expect(result.content).toContain("Name: nginx");
    expect(result.content).toContain("=== LOGS (last 100) ===");
    expect(result.content).toContain("=== PREVIOUS LOGS ===");
    expect(result.content).toContain("=== EVENTS ===");
    // The exec() method itself catches errors and returns "Error: ..."
    // so each section will have content regardless
  });

  it("triage_pod uses correct namespace and pod name in commands", async () => {
    mockExecFileSuccess("ok");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("triage_pod")!;
    await tool.handler({ pod: "web-0", namespace: "staging" });

    // 4 exec calls: describe, logs, logs --previous, get events
    expect(mockedExecFile).toHaveBeenCalledTimes(4);

    // Check describe pod args
    const describeArgs = mockedExecFile.mock.calls[0][1];
    expect(describeArgs).toEqual(["describe", "pod", "web-0", "-n", "staging"]);

    // Check logs args
    const logsArgs = mockedExecFile.mock.calls[1][1];
    expect(logsArgs).toEqual(["logs", "web-0", "-n", "staging", "--tail", "100"]);
  });

  // ─── triage_deployment ──────────────────────────────────────────────────

  it("triage_deployment collects all 5 sections", async () => {
    mockExecFileMixed([
      { stdout: "deployment successfully rolled out" },
      { stdout: "Name: web\nReplicas: 3" },
      { stdout: "NAME          DESIRED  CURRENT  READY" },
      { stdout: "NAME       READY  STATUS" },
      { stdout: "EVENTS" },
    ]);

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("triage_deployment")!;
    const result = await tool.handler({ deployment: "web", namespace: "prod" });

    expect(result.content).toContain("=== ROLLOUT STATUS ===");
    expect(result.content).toContain("=== DESCRIBE DEPLOYMENT ===");
    expect(result.content).toContain("=== REPLICASETS ===");
    expect(result.content).toContain("=== PODS ===");
    expect(result.content).toContain("=== EVENTS ===");
    expect(mockedExecFile).toHaveBeenCalledTimes(5);
  });

  it("triage_deployment tolerates all failures without throwing", async () => {
    mockExecFileError("kubectl: connection refused", "connection refused");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("triage_deployment")!;
    const result = await tool.handler({ deployment: "broken" });

    // Should have all 5 sections, each showing the error from exec()
    expect(result.content).toContain("=== ROLLOUT STATUS ===");
    expect(result.content).toContain("=== DESCRIBE DEPLOYMENT ===");
    expect(result.content).toContain("=== REPLICASETS ===");
    expect(result.content).toContain("=== PODS ===");
    expect(result.content).toContain("=== EVENTS ===");
  });

  // ─── triage_node ────────────────────────────────────────────────────────

  it("triage_node collects all 3 sections", async () => {
    mockExecFileMixed([
      { stdout: "Name: node-1\nRoles: worker" },
      { stdout: "NAME       CPU   MEMORY" },
      { stdout: "No events" },
    ]);

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("triage_node")!;
    const result = await tool.handler({ node: "node-1" });

    expect(result.content).toContain("=== DESCRIBE NODE ===");
    expect(result.content).toContain("=== POD METRICS ON NODE ===");
    expect(result.content).toContain("=== NODE EVENTS ===");
    expect(mockedExecFile).toHaveBeenCalledTimes(3);

    // Verify first call is describe node (no namespace flag)
    const describeArgs = mockedExecFile.mock.calls[0][1];
    expect(describeArgs).toEqual(["describe", "node", "node-1"]);
  });

  // ─── check_endpoints ───────────────────────────────────────────────────

  it("check_endpoints probes URLs and returns status + latency", async () => {
    mockFetch
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 503 });

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("check_endpoints")!;
    const result = await tool.handler({ urls: ["http://app:8080/health", "http://db:5432/health"] });

    expect(result.content).toContain("http://app:8080/health -> 200");
    expect(result.content).toContain("ms)");
    expect(result.content).toContain("http://db:5432/health -> 503");
  });

  it("check_endpoints handles fetch errors per URL", async () => {
    mockFetch
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("check_endpoints")!;
    const result = await tool.handler({ urls: ["http://ok:80", "http://down:80"] });

    expect(result.content).toContain("http://ok:80 -> 200");
    expect(result.content).toContain("http://down:80 -> ERROR: ECONNREFUSED");
  });
});
