import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { ReleaseAgent } from "../src/agents/release-agent.js";
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

// ─── Tests ──────────────────────────────────────────────────────────────────

const PORT = 19930;

describe("ReleaseAgent", () => {
  let agent: ReleaseAgent;
  const origEnv = { ...process.env };

  beforeAll(async () => {
    process.env.AGENT_PORT = String(PORT);
    process.env.AGENT_NAMESPACE = "release-ns";
    agent = new ReleaseAgent();
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

  it("registers all 6 release tools", () => {
    const tools = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools;
    expect(tools.size).toBe(6);
    expect([...tools.keys()]).toEqual([
      "build_image",
      "push_image",
      "run_tests",
      "git_status",
      "argocd_sync",
      "deployment_status",
    ]);
  });

  // ─── build_image ────────────────────────────────────────────────────────

  it("build_image builds correct docker build command", async () => {
    mockExecFileSuccess("Successfully built abc123");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("build_image")!;
    const result = await tool.handler({ tag: "myapp:v1.0.0", context: "." });

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("docker");
    expect(callArgs[1]).toEqual(["build", "-t", "myapp:v1.0.0", "."]);
    expect(result.content).toContain("Successfully built");
  });

  it("build_image includes --no-cache and --build-arg flags", async () => {
    mockExecFileSuccess("built");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("build_image")!;
    await tool.handler({
      tag: "myapp:latest",
      context: "./app",
      noCache: true,
      buildArgs: ["NODE_ENV=production", "VERSION=1.0"],
    });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual([
      "build", "-t", "myapp:latest",
      "--no-cache",
      "--build-arg", "NODE_ENV=production",
      "--build-arg", "VERSION=1.0",
      "./app",
    ]);
  });

  // ─── push_image ─────────────────────────────────────────────────────────

  it("push_image runs docker push with correct tag", async () => {
    mockExecFileSuccess("pushed: myapp:v1.0.0");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("push_image")!;
    const result = await tool.handler({ tag: "registry.io/myapp:v1.0.0" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("docker");
    expect(callArgs[1]).toEqual(["push", "registry.io/myapp:v1.0.0"]);
    expect(result.content).toContain("pushed");
  });

  // ─── run_tests ──────────────────────────────────────────────────────────

  it("run_tests executes command with args", async () => {
    mockExecFileSuccess("All 42 tests passed");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("run_tests")!;
    const result = await tool.handler({ command: "npm", args: ["test", "--", "--coverage"] });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("npm");
    expect(callArgs[1]).toEqual(["test", "--", "--coverage"]);
    expect(result.content).toContain("42 tests passed");
  });

  it("run_tests handles test failures", async () => {
    mockExecFileError("test failed", "FAIL src/index.test.ts");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("run_tests")!;
    const result = await tool.handler({ command: "npm", args: ["test"] });

    expect(result.content).toContain("Error:");
    expect(result.content).toContain("FAIL");
  });

  // ─── git_status ─────────────────────────────────────────────────────────

  it("git_status combines all 4 git commands", async () => {
    let callIndex = 0;
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      const outputs = [
        "On branch main\nnothing to commit",
        "abc1234 feat: add feature\ndef5678 fix: fix bug",
        "main",
        " 3 files changed, 50 insertions(+), 10 deletions(-)",
      ];
      cb(null, { stdout: outputs[callIndex++] ?? "", stderr: "" });
    });

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("git_status")!;
    const result = await tool.handler({});

    expect(result.content).toContain("=== GIT STATUS ===");
    expect(result.content).toContain("=== RECENT COMMITS ===");
    expect(result.content).toContain("=== CURRENT BRANCH ===");
    expect(result.content).toContain("=== DIFF STAT ===");
    expect(result.content).toContain("nothing to commit");
    expect(result.content).toContain("feat: add feature");
    expect(result.content).toContain("main");
    expect(mockedExecFile).toHaveBeenCalledTimes(4);
  });

  // ─── argocd_sync ────────────────────────────────────────────────────────

  it("argocd_sync builds correct command with revision and prune", async () => {
    mockExecFileSuccess("Application synced");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("argocd_sync")!;
    await tool.handler({ appName: "my-app", revision: "v1.2.0", prune: true });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[0]).toBe("argocd");
    expect(callArgs[1]).toEqual(["app", "sync", "my-app", "--revision", "v1.2.0", "--prune"]);
  });

  it("argocd_sync with app name only", async () => {
    mockExecFileSuccess("synced");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("argocd_sync")!;
    await tool.handler({ appName: "web-app" });

    const callArgs = mockedExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual(["app", "sync", "web-app"]);
  });

  // ─── deployment_status ──────────────────────────────────────────────────

  it("deployment_status collects all 3 sections", async () => {
    let callIndex = 0;
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      const outputs = [
        "NAME   READY   UP-TO-DATE   AVAILABLE",
        "NAME         READY   STATUS    RESTARTS",
        "LAST SEEN   TYPE   REASON",
      ];
      cb(null, { stdout: outputs[callIndex++] ?? "", stderr: "" });
    });

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("deployment_status")!;
    const result = await tool.handler({ deployment: "web", namespace: "prod" });

    expect(result.content).toContain("=== DEPLOYMENT ===");
    expect(result.content).toContain("=== PODS ===");
    expect(result.content).toContain("=== EVENTS ===");
    expect(mockedExecFile).toHaveBeenCalledTimes(3);

    // Verify namespace is used
    const firstArgs = mockedExecFile.mock.calls[0][1];
    expect(firstArgs).toContain("prod");
  });

  it("deployment_status uses AGENT_NAMESPACE as default", async () => {
    mockExecFileSuccess("ok");

    const tool = (agent as unknown as { tools: Map<string, { handler: Function }> }).tools.get("deployment_status")!;
    await tool.handler({ deployment: "api" });

    // First call should use release-ns
    const firstArgs = mockedExecFile.mock.calls[0][1];
    expect(firstArgs).toContain("release-ns");
  });
});
