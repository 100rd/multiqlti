import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { HelmAgent } from "../src/agents/helm-agent.js";
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

  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  }, 5);

  return proc;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const PORT = 19901;
const BASE = `http://localhost:${PORT}`;

describe("HelmAgent", () => {
  let agent: HelmAgent;
  const origEnv = { ...process.env };

  beforeAll(async () => {
    process.env.AGENT_PORT = String(PORT);
    process.env.AGENT_NAMESPACE = "test-ns";
    agent = new HelmAgent();
    await agent.start();
  });

  afterAll(async () => {
    await agent.stop();
    process.env = origEnv;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper to get tool handler directly
  function getTool(name: string) {
    return (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get(name)!;
  }

  // ─── Tool registration ──────────────────────────────────────────────────

  it("registers all 7 helm tools", async () => {
    const res = await fetch(`${BASE}/.well-known/agent.json`);
    const card = await res.json();
    expect(card.skills).toHaveLength(7);
    const names = card.skills.map((s: { id: string }) => s.id);
    expect(names).toEqual([
      "helm_list",
      "helm_install",
      "helm_upgrade",
      "helm_rollback",
      "helm_status",
      "helm_history",
      "helm_values",
    ]);
  });

  it("agent card has correct metadata", async () => {
    const res = await fetch(`${BASE}/.well-known/agent.json`);
    const card = await res.json();
    expect(card.name).toBe("helm-agent");
    expect(card.version).toBe("0.1.0");
    expect(card.description).toContain("Helm");
  });

  // ─── helm_list ──────────────────────────────────────────────────────────

  it("helm_list builds correct args with default namespace", async () => {
    mockExecFileSuccess('[{"name":"myapp","status":"deployed"}]');

    await getTool("helm_list").handler({});

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("helm");
    expect(callArgs[1]).toEqual(["list", "-n", "test-ns", "-o", "json"]);
  });

  it("helm_list with all-namespaces and filter", async () => {
    mockExecFileSuccess("[]");

    await getTool("helm_list").handler({ allNamespaces: true, filter: "web.*" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["list", "--all-namespaces", "--filter", "web.*", "-o", "json"]);
    // Should NOT have -n flag when allNamespaces is true
    expect(callArgs[1]).not.toContain("-n");
  });

  // ─── helm_install ─────────────────────────────────────────────────────

  it("helm_install builds correct args for basic install", async () => {
    mockExecFileSuccess('{"name":"myapp","info":{"status":"deployed"}}');

    await getTool("helm_install").handler({ release: "myapp", chart: "bitnami/nginx" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("helm");
    expect(callArgs[1]).toEqual(["install", "myapp", "bitnami/nginx", "-n", "test-ns", "-o", "json"]);
  });

  it("helm_install with values via stdin, version, dry-run, wait, create-namespace", async () => {
    const values = "replicaCount: 3\nimage:\n  tag: latest";
    createMockSpawnProcess('{"name":"myapp"}', 0);

    await getTool("helm_install").handler({
      release: "myapp",
      chart: "bitnami/nginx",
      values,
      version: "1.2.3",
      dryRun: true,
      wait: true,
      timeout: "5m0s",
      createNamespace: true,
    });

    const spawnArgs = mockedSpawn.mock.calls[0];
    expect(spawnArgs[0]).toBe("helm");
    expect(spawnArgs[1]).toEqual([
      "install", "myapp", "bitnami/nginx",
      "-n", "test-ns",
      "--version", "1.2.3",
      "--dry-run",
      "--wait",
      "--timeout", "5m0s",
      "--create-namespace",
      "-o", "json",
      "-f", "-",
    ]);

    const proc = mockedSpawn.mock.results[0].value;
    expect(proc.stdin.write).toHaveBeenCalledWith(values);
  });

  it("helm_install with --set value overrides", async () => {
    mockExecFileSuccess('{"name":"myapp"}');

    await getTool("helm_install").handler({
      release: "myapp",
      chart: "bitnami/nginx",
      set: ["image.tag=v2", "replicaCount=3"],
    });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toContain("--set");
    expect(callArgs[1]).toContain("image.tag=v2");
    expect(callArgs[1]).toContain("replicaCount=3");
  });

  // ─── helm_upgrade ─────────────────────────────────────────────────────

  it("helm_upgrade with --reuse-values", async () => {
    mockExecFileSuccess('{"name":"myapp"}');

    await getTool("helm_upgrade").handler({
      release: "myapp",
      chart: "bitnami/nginx",
      reuseValues: true,
    });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual([
      "upgrade", "myapp", "bitnami/nginx",
      "-n", "test-ns",
      "--reuse-values",
      "-o", "json",
    ]);
  });

  it("helm_upgrade with --install and --reset-values", async () => {
    mockExecFileSuccess('{"name":"myapp"}');

    await getTool("helm_upgrade").handler({
      release: "myapp",
      chart: "bitnami/nginx",
      resetValues: true,
      install: true,
      namespace: "prod",
    });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toContain("--reset-values");
    expect(callArgs[1]).toContain("--install");
    expect(callArgs[1]).toContain("prod");
  });

  it("helm_upgrade with values via stdin", async () => {
    const values = "replicaCount: 5";
    createMockSpawnProcess('{"name":"myapp"}', 0);

    await getTool("helm_upgrade").handler({
      release: "myapp",
      chart: "bitnami/nginx",
      values,
    });

    expect(mockedSpawn).toHaveBeenCalled();
    const spawnArgs = mockedSpawn.mock.calls[0];
    expect(spawnArgs[1]).toContain("-f");
    expect(spawnArgs[1]).toContain("-");
  });

  // ─── helm_rollback ────────────────────────────────────────────────────

  it("helm_rollback builds correct args with revision", async () => {
    mockExecFileSuccess("Rollback was a success!");

    await getTool("helm_rollback").handler({ release: "myapp", revision: 3 });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("helm");
    expect(callArgs[1]).toEqual(["rollback", "myapp", "3", "-n", "test-ns"]);
  });

  it("helm_rollback with wait and dry-run", async () => {
    mockExecFileSuccess("Rollback simulated");

    await getTool("helm_rollback").handler({
      release: "myapp",
      revision: 2,
      wait: true,
      timeout: "3m0s",
      dryRun: true,
    });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual([
      "rollback", "myapp", "2",
      "-n", "test-ns",
      "--wait",
      "--timeout", "3m0s",
      "--dry-run",
    ]);
  });

  // ─── helm_status ──────────────────────────────────────────────────────

  it("helm_status builds correct args", async () => {
    mockExecFileSuccess('{"name":"myapp","info":{"status":"deployed"}}');

    await getTool("helm_status").handler({ release: "myapp" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["status", "myapp", "-n", "test-ns", "-o", "json"]);
  });

  it("helm_status with specific revision and output format", async () => {
    mockExecFileSuccess("name: myapp\nstatus: superseded");

    await getTool("helm_status").handler({ release: "myapp", revision: 5, output: "yaml" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["status", "myapp", "-n", "test-ns", "--revision", "5", "-o", "yaml"]);
  });

  // ─── helm_history ─────────────────────────────────────────────────────

  it("helm_history builds correct args with max", async () => {
    mockExecFileSuccess('[{"revision":1},{"revision":2}]');

    await getTool("helm_history").handler({ release: "myapp", max: 10 });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["history", "myapp", "-n", "test-ns", "--max", "10", "-o", "json"]);
  });

  // ─── helm_values ──────────────────────────────────────────────────────

  it("helm_values builds correct args with --all flag", async () => {
    mockExecFileSuccess('{"replicaCount":1}');

    await getTool("helm_values").handler({ release: "myapp", all: true });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["get", "values", "myapp", "-n", "test-ns", "--all", "-o", "json"]);
  });

  it("helm_values with specific revision", async () => {
    mockExecFileSuccess('{"replicaCount":3}');

    await getTool("helm_values").handler({ release: "myapp", revision: 4, output: "yaml" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["get", "values", "myapp", "-n", "test-ns", "--revision", "4", "-o", "yaml"]);
  });

  // ─── Error handling ─────────────────────────────────────────────────────

  it("returns error content on command failure", async () => {
    mockExecFileError("command failed", "Error: release not found");

    const result = await getTool("helm_status").handler({ release: "nonexistent" });
    expect(result.content).toContain("Error:");
    expect(result.content).toContain("release not found");
  });

  // ─── Namespace handling ─────────────────────────────────────────────────

  it("uses AGENT_NAMESPACE env var as default namespace", async () => {
    mockExecFileSuccess("[]");

    await getTool("helm_list").handler({});

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toContain("test-ns");
  });

  it("namespace parameter overrides AGENT_NAMESPACE", async () => {
    mockExecFileSuccess("[]");

    await getTool("helm_list").handler({ namespace: "custom-ns" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toContain("custom-ns");
    expect(callArgs[1]).not.toContain("test-ns");
  });
});
