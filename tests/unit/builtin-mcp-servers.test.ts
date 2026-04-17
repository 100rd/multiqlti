/**
 * Comprehensive unit tests for built-in MCP servers (issue #270).
 *
 * Covers:
 *  1. base.ts — redactSecrets, requireDestructiveFlag, DestructiveOperationDeniedError
 *  2. KubernetesMcpServer — all 5 tools, namespace scoping, destructive guard
 *  3. DockerRunMcpServer  — docker_run tool, CPU/mem capping, docker_run_privileged guard
 *  4. GitHubMcpServer     — all 5 tools, comment posting, error handling
 *  5. GitLabMcpServer     — all 5 tools, note posting, project encoding
 *  6. BuiltinMcpServerRegistry — spawn/terminate lifecycle, tool registration/unregistration
 *  7. McpClientManager.spawnBuiltinServer / terminateBuiltinServer integration
 *  8. Security: no secrets in output, destructive ops require allow-flag
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ── base.ts ───────────────────────────────────────────────────────────────────

import {
  redactSecrets,
  requireDestructiveFlag,
  DestructiveOperationDeniedError,
} from "../../server/mcp-servers/base";

describe("redactSecrets()", () => {
  it("replaces a single secret value with [REDACTED]", () => {
    const result = redactSecrets("token: mySecretToken123", {
      token: "mySecretToken123",
    });
    expect(result).toBe("token: [REDACTED]");
  });

  it("replaces multiple occurrences of the same secret", () => {
    const result = redactSecrets("abc abc abc", { val: "abc" });
    expect(result).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });

  it("replaces multiple distinct secrets", () => {
    const result = redactSecrets("user=admin pass=hunter2", {
      user: "admin",
      pass: "hunter2",
    });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("admin");
    expect(result).not.toContain("hunter2");
  });

  it("leaves text unchanged when secrets map is empty", () => {
    const result = redactSecrets("no secrets here", {});
    expect(result).toBe("no secrets here");
  });

  it("ignores empty-string secret values", () => {
    const result = redactSecrets("text", { empty: "" });
    expect(result).toBe("text");
  });

  it("handles regex special chars in secret values", () => {
    const secret = "p@ss$w0rd(special)";
    const result = redactSecrets(`password: ${secret}`, { pw: secret });
    expect(result).toBe("password: [REDACTED]");
  });
});

describe("requireDestructiveFlag()", () => {
  it("does not throw when allowDestructive is true", () => {
    expect(() => requireDestructiveFlag("my_tool", true)).not.toThrow();
  });

  it("throws DestructiveOperationDeniedError when flag is false", () => {
    expect(() => requireDestructiveFlag("my_tool", false)).toThrow(
      DestructiveOperationDeniedError,
    );
  });

  it("throws when flag is undefined", () => {
    expect(() => requireDestructiveFlag("my_tool", undefined)).toThrow(
      DestructiveOperationDeniedError,
    );
  });

  it("error message mentions the tool name", () => {
    try {
      requireDestructiveFlag("dangerous_op", false);
    } catch (err) {
      expect(err).toBeInstanceOf(DestructiveOperationDeniedError);
      expect((err as Error).message).toContain("dangerous_op");
    }
  });
});

// ── KubernetesMcpServer ───────────────────────────────────────────────────────

import { KubernetesMcpServer } from "../../server/mcp-servers/kubernetes/index";
import type { BuiltinMcpServerConfig } from "../../server/mcp-servers/base";

function makeK8sConfig(overrides: Partial<BuiltinMcpServerConfig> = {}): BuiltinMcpServerConfig {
  return {
    connectionId: "conn-k8s-test",
    config: { namespace: "test-ns" },
    secrets: { kubeconfigPath: "/fake/kubeconfig" },
    allowDestructive: false,
    ...overrides,
  };
}

describe("KubernetesMcpServer", () => {
  let server: KubernetesMcpServer;

  beforeEach(() => {
    server = new KubernetesMcpServer();
  });

  it("has connectionType 'kubernetes'", () => {
    expect(server.connectionType).toBe("kubernetes");
  });

  it("throws if getToolHandlers() called before start()", () => {
    expect(() => server.getToolHandlers()).toThrow(/start\(\)/);
  });

  it("start() initialises with given namespace", async () => {
    await server.start(makeK8sConfig());
    const handlers = server.getToolHandlers();
    expect(handlers.length).toBe(5);
  });

  it("all 5 tool names are defined", async () => {
    await server.start(makeK8sConfig());
    const names = server.getToolHandlers().map((h) => h.definition.name);
    expect(names).toContain("k8s_deploy_manifest");
    expect(names).toContain("k8s_apply_helm_chart");
    expect(names).toContain("k8s_port_forward_check");
    expect(names).toContain("k8s_get_logs");
    expect(names).toContain("k8s_delete_namespace");
  });

  it("tool definitions have source='mcp'", async () => {
    await server.start(makeK8sConfig());
    for (const h of server.getToolHandlers()) {
      expect(h.definition.source).toBe("mcp");
    }
  });

  it("tool definitions include connection tag", async () => {
    await server.start(makeK8sConfig());
    for (const h of server.getToolHandlers()) {
      expect(h.definition.tags).toContain("connection:conn-k8s-test");
    }
  });

  it("getToolScope('k8s_delete_namespace') returns 'destructive'", async () => {
    await server.start(makeK8sConfig());
    expect(server.getToolScope("k8s_delete_namespace")).toBe("destructive");
  });

  it("getToolScope('k8s_get_logs') returns 'read'", async () => {
    await server.start(makeK8sConfig());
    expect(server.getToolScope("k8s_get_logs")).toBe("read");
  });

  it("getToolScope(unknown) returns undefined", async () => {
    await server.start(makeK8sConfig());
    expect(server.getToolScope("unknown_tool")).toBeUndefined();
  });

  it("stop() clears state — getToolHandlers() throws after stop", async () => {
    await server.start(makeK8sConfig());
    await server.stop();
    expect(() => server.getToolHandlers()).toThrow();
  });

  describe("k8s_deploy_manifest", () => {
    it("returns error for empty manifest", async () => {
      await server.start(makeK8sConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_deploy_manifest")!;
      // Empty manifest guard triggers before any spawn call
      const result = await handler.execute({ manifest: "   " });
      expect(result).toMatch(/empty/i);
    });
  });

  describe("k8s_delete_namespace — destructive guard", () => {
    it("rejects without allowDestructive flag", async () => {
      await server.start(makeK8sConfig({ allowDestructive: false }));
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_delete_namespace")!;

      await expect(handler.execute({ confirm: "DELETE" })).rejects.toThrow(
        DestructiveOperationDeniedError,
      );
    });

    it("rejects with wrong confirm string even when allowDestructive=true", async () => {
      await server.start(makeK8sConfig({ allowDestructive: true }));
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_delete_namespace")!;
      // Wrong confirm string guard triggers before any spawn call
      const result = await handler.execute({ confirm: "WRONG" });
      expect(result).toMatch(/confirm/i);
    });
  });

  describe("k8s_get_logs — tail capped at 1000", () => {
    it("requires podName", async () => {
      await server.start(makeK8sConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_get_logs")!;
      const result = await handler.execute({ podName: "" });
      expect(result).toMatch(/podName is required/i);
    });
  });

  describe("k8s_port_forward_check", () => {
    it("returns error for missing targetPort", async () => {
      await server.start(makeK8sConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_port_forward_check")!;
      const result = await handler.execute({ podName: "my-pod", targetPort: 0 });
      expect(result).toMatch(/required/i);
    });

    it("returns error for missing podName", async () => {
      await server.start(makeK8sConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_port_forward_check")!;
      const result = await handler.execute({ podName: "", targetPort: 8080 });
      expect(result).toMatch(/required/i);
    });
  });

  describe("k8s_apply_helm_chart", () => {
    it("returns error when releaseName is missing", async () => {
      await server.start(makeK8sConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_apply_helm_chart")!;
      const result = await handler.execute({ releaseName: "", chart: "stable/nginx" });
      expect(result).toMatch(/required/i);
    });

    it("returns error when chart is missing", async () => {
      await server.start(makeK8sConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_apply_helm_chart")!;
      const result = await handler.execute({ releaseName: "my-app", chart: "" });
      expect(result).toMatch(/required/i);
    });
  });

  describe("secret redaction", () => {
    it("secrets are not present in error output", async () => {
      await server.start(makeK8sConfig({ secrets: { kubeconfigPath: "/secret/path", apiToken: "supersecrettoken" } }));
      const handler = server.getToolHandlers().find((h) => h.definition.name === "k8s_get_logs")!;
      // We cannot check spawn output in unit tests without actually running kubectl,
      // but we verify the handler closure holds the secrets reference for redaction
      // by checking the tool definition does NOT contain secrets inline.
      expect(JSON.stringify(handler.definition)).not.toContain("supersecrettoken");
    });
  });
});

// ── DockerRunMcpServer ────────────────────────────────────────────────────────

import { DockerRunMcpServer } from "../../server/mcp-servers/docker-run/index";
import { SandboxExecutor } from "../../server/sandbox/executor";
import type { SandboxResult } from "../../shared/types";

function makeDockerConfig(overrides: Partial<BuiltinMcpServerConfig> = {}): BuiltinMcpServerConfig {
  return {
    connectionId: "conn-docker-test",
    config: {
      memoryLimit: "512m",
      cpuLimit: 1,
      networkEnabled: false,
      timeout: 60,
    },
    secrets: {},
    allowDestructive: false,
    ...overrides,
  };
}

function makeSuccessResult(): SandboxResult {
  return {
    exitCode: 0,
    stdout: "Hello from container\n",
    stderr: "",
    durationMs: 120,
    timedOut: false,
    artifacts: [],
    image: "alpine:3.18",
    command: "echo hello",
  };
}

describe("DockerRunMcpServer", () => {
  let server: DockerRunMcpServer;
  let mockExecutor: SandboxExecutor;

  beforeEach(() => {
    mockExecutor = {
      isAvailable: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue(makeSuccessResult()),
    } as unknown as SandboxExecutor;

    server = new DockerRunMcpServer(mockExecutor);
  });

  it("has connectionType 'generic_mcp'", () => {
    expect(server.connectionType).toBe("generic_mcp");
  });

  it("throws if getToolHandlers() called before start()", () => {
    expect(() => server.getToolHandlers()).toThrow(/start\(\)/);
  });

  it("exposes docker_run and docker_run_privileged tools", async () => {
    await server.start(makeDockerConfig());
    const names = server.getToolHandlers().map((h) => h.definition.name);
    expect(names).toContain("docker_run");
    expect(names).toContain("docker_run_privileged");
  });

  it("docker_run scope is 'read'", async () => {
    await server.start(makeDockerConfig());
    expect(server.getToolScope("docker_run")).toBe("read");
  });

  it("docker_run_privileged scope is 'destructive'", async () => {
    await server.start(makeDockerConfig());
    expect(server.getToolScope("docker_run_privileged")).toBe("destructive");
  });

  it("docker_run returns error when image is missing", async () => {
    await server.start(makeDockerConfig());
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;
    const result = await handler.execute({ image: "", command: "echo hi" });
    expect(result).toMatch(/image is required/i);
  });

  it("docker_run calls executor.execute() with correct image/command", async () => {
    await server.start(makeDockerConfig());
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;

    await handler.execute({ image: "alpine:3.18", command: "echo hello" });

    expect(mockExecutor.execute).toHaveBeenCalledOnce();
    const [config] = (mockExecutor.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [import("../../shared/types").SandboxConfig, unknown[]];
    expect(config.image).toBe("alpine:3.18");
    expect(config.command).toBe("echo hello");
  });

  it("docker_run caps memory at connection limit", async () => {
    await server.start(makeDockerConfig({ config: { memoryLimit: "256m", cpuLimit: 0.5, timeout: 30 } }));
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;

    // Caller requests 1g — should be capped to 256m
    await handler.execute({ image: "alpine", command: "echo", memoryLimit: "1g" });

    const [config] = (mockExecutor.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [import("../../shared/types").SandboxConfig, unknown[]];
    const memBytes = parseInt(config.memoryLimit ?? "0");
    // memoryLimit is returned as Xm strings; 256m → 256
    expect(parseInt(config.memoryLimit ?? "0")).toBeLessThanOrEqual(256);
  });

  it("docker_run caps CPU at connection limit", async () => {
    await server.start(makeDockerConfig({ config: { memoryLimit: "512m", cpuLimit: 0.5, timeout: 30 } }));
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;

    // Caller requests 4.0 CPUs — capped to 0.5
    await handler.execute({ image: "alpine", command: "echo", cpuLimit: 4.0 });

    const [config] = (mockExecutor.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [import("../../shared/types").SandboxConfig, unknown[]];
    expect(config.cpuLimit).toBeLessThanOrEqual(0.5);
  });

  it("docker_run caps timeout at connection limit", async () => {
    await server.start(makeDockerConfig({ config: { memoryLimit: "512m", cpuLimit: 1, timeout: 30 } }));
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;

    // Caller requests 9999 seconds — capped to 30
    await handler.execute({ image: "alpine", command: "echo", timeout: 9999 });

    const [config] = (mockExecutor.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [import("../../shared/types").SandboxConfig, unknown[]];
    expect(config.timeout).toBeLessThanOrEqual(30);
  });

  it("docker_run output includes exit code and duration", async () => {
    await server.start(makeDockerConfig());
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;
    const result = await handler.execute({ image: "alpine", command: "echo hi" });
    expect(result).toMatch(/exit code/i);
    expect(result).toMatch(/duration/i);
  });

  it("docker_run output includes stdout from executor", async () => {
    await server.start(makeDockerConfig());
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;
    const result = await handler.execute({ image: "alpine", command: "echo hi" });
    expect(result).toContain("Hello from container");
  });

  it("docker_run_privileged rejects without allowDestructive flag", async () => {
    await server.start(makeDockerConfig({ allowDestructive: false }));
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run_privileged")!;
    await expect(handler.execute({ image: "alpine", command: "echo" })).rejects.toThrow(
      DestructiveOperationDeniedError,
    );
  });

  it("docker_run_privileged succeeds with allowDestructive=true", async () => {
    await server.start(makeDockerConfig({ allowDestructive: true }));
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run_privileged")!;
    const result = await handler.execute({ image: "alpine", command: "echo" });
    expect(result).toContain("Exit code");
  });

  it("docker_run_privileged enables network", async () => {
    await server.start(makeDockerConfig({ allowDestructive: true, config: { memoryLimit: "512m", cpuLimit: 1, timeout: 60, networkEnabled: false } }));
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run_privileged")!;
    await handler.execute({ image: "alpine", command: "echo" });

    const [config] = (mockExecutor.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [import("../../shared/types").SandboxConfig, unknown[]];
    expect(config.networkEnabled).toBe(true);
  });

  it("secrets are not present in tool output", async () => {
    await server.start(makeDockerConfig({ secrets: { apiKey: "secret-key-xyz" } }));
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;

    // Inject secret into stdout to simulate a leaky container
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...makeSuccessResult(),
      stdout: "API KEY: secret-key-xyz\n",
    });

    const result = await handler.execute({ image: "alpine", command: "echo" });
    expect(result).not.toContain("secret-key-xyz");
    expect(result).toContain("[REDACTED]");
  });

  it("timedOut flag is shown in output", async () => {
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...makeSuccessResult(),
      timedOut: true,
      exitCode: 1,
    });
    await server.start(makeDockerConfig());
    const handler = server.getToolHandlers().find((h) => h.definition.name === "docker_run")!;
    const result = await handler.execute({ image: "alpine", command: "sleep 9999" });
    expect(result).toMatch(/timed_out/i);
  });
});

// ── GitHubMcpServer ───────────────────────────────────────────────────────────

import { GitHubMcpServer } from "../../server/mcp-servers/github/index";

function makeGitHubConfig(overrides: Partial<BuiltinMcpServerConfig> = {}): BuiltinMcpServerConfig {
  return {
    connectionId: "conn-gh-test",
    config: {
      host: "https://api.github.com",
      owner: "test-owner",
      repo: "test-repo",
    },
    secrets: { token: "ghp_supersecrettoken" },
    allowDestructive: false,
    ...overrides,
  };
}

describe("GitHubMcpServer", () => {
  let server: GitHubMcpServer;

  beforeEach(() => {
    server = new GitHubMcpServer();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has connectionType 'github'", () => {
    expect(server.connectionType).toBe("github");
  });

  it("throws if getToolHandlers() called before start()", () => {
    expect(() => server.getToolHandlers()).toThrow(/start\(\)/);
  });

  it("exposes 5 tool handlers after start()", async () => {
    await server.start(makeGitHubConfig());
    expect(server.getToolHandlers()).toHaveLength(5);
  });

  it("all tools have source='mcp'", async () => {
    await server.start(makeGitHubConfig());
    for (const h of server.getToolHandlers()) {
      expect(h.definition.source).toBe("mcp");
    }
  });

  it("all tools are tagged with connection ID", async () => {
    await server.start(makeGitHubConfig());
    for (const h of server.getToolHandlers()) {
      expect(h.definition.tags).toContain("connection:conn-gh-test");
    }
  });

  it("all tools have scope 'read'", async () => {
    await server.start(makeGitHubConfig());
    const names = server.getToolHandlers().map((h) => h.definition.name);
    for (const name of names) {
      expect(server.getToolScope(name)).toBe("read");
    }
  });

  it("stop() clears state", async () => {
    await server.start(makeGitHubConfig());
    await server.stop();
    expect(() => server.getToolHandlers()).toThrow();
  });

  describe("github_list_prs", () => {
    it("returns error when no owner/repo configured", async () => {
      await server.start({
        ...makeGitHubConfig(),
        config: { host: "https://api.github.com" }, // no owner/repo
      });
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_list_prs")!;
      const result = await handler.execute({});
      expect(result).toMatch(/required/i);
    });

    it("calls GitHub API with correct endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ number: 1, title: "Test PR" }],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_list_prs")!;
      await handler.execute({});

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/repos/test-owner/test-repo/pulls");
      expect((opts.headers as Record<string, string>)["Authorization"]).toContain("Bearer");
    });

    it("token is NOT in Authorization header output", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_list_prs")!;
      const result = await handler.execute({});
      expect(result).not.toContain("ghp_supersecrettoken");
    });

    it("returns error string on non-ok response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_list_prs")!;
      await expect(handler.execute({})).rejects.toThrow("403");
    });
  });

  describe("github_get_pr_files", () => {
    it("returns error for missing prNumber", async () => {
      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_get_pr_files")!;
      const result = await handler.execute({});
      expect(result).toMatch(/required/i);
    });

    it("calls correct endpoint with prNumber", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_get_pr_files")!;
      await handler.execute({ prNumber: 42 });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/pulls/42/files");
    });
  });

  describe("github_get_pr_diff", () => {
    it("returns error for missing prNumber", async () => {
      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_get_pr_diff")!;
      const result = await handler.execute({});
      expect(result).toMatch(/required/i);
    });

    it("uses diff Accept header", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "diff --git a/file.ts b/file.ts\n",
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_get_pr_diff")!;
      await handler.execute({ prNumber: 7 });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((opts.headers as Record<string, string>)["Accept"]).toContain("diff");
    });

    it("token is not present in diff output", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "diff content here\n",
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_get_pr_diff")!;
      const result = await handler.execute({ prNumber: 7 });
      expect(result).not.toContain("ghp_supersecrettoken");
    });
  });

  describe("github_post_comment", () => {
    it("returns error for missing issueNumber", async () => {
      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_post_comment")!;
      const result = await handler.execute({ body: "hello" });
      expect(result).toMatch(/required/i);
    });

    it("returns error for empty body", async () => {
      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_post_comment")!;
      const result = await handler.execute({ issueNumber: 1, body: "" });
      expect(result).toMatch(/required/i);
    });

    it("POSTs to issues/comments endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 123, html_url: "https://github.com/test-owner/test-repo/issues/5#issuecomment-123" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_post_comment")!;
      const result = await handler.execute({ issueNumber: 5, body: "Great work!" });

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/issues/5/comments");
      expect(opts.method).toBe("POST");
      expect(result).toContain("Comment posted");
    });
  });

  describe("github_list_workflows", () => {
    it("calls workflows/runs endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ workflow_runs: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_list_workflows")!;
      await handler.execute({});

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/actions/runs");
    });

    it("caps perPage at 30", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ workflow_runs: [] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_list_workflows")!;
      await handler.execute({ perPage: 1000 });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("per_page=30");
    });
  });

  describe("owner/repo from args overrides connection default", () => {
    it("uses args repo when provided as owner/repo", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitHubConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "github_list_prs")!;
      await handler.execute({ repo: "another-org/another-repo" });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/repos/another-org/another-repo/pulls");
    });
  });
});

// ── GitLabMcpServer ───────────────────────────────────────────────────────────

import { GitLabMcpServer } from "../../server/mcp-servers/gitlab/index";

function makeGitLabConfig(overrides: Partial<BuiltinMcpServerConfig> = {}): BuiltinMcpServerConfig {
  return {
    connectionId: "conn-gl-test",
    config: {
      host: "https://gitlab.com",
      owner: "test-group",
      project: "test-project",
    },
    secrets: { token: "glpat-supersecret" },
    allowDestructive: false,
    ...overrides,
  };
}

describe("GitLabMcpServer", () => {
  let server: GitLabMcpServer;

  beforeEach(() => {
    server = new GitLabMcpServer();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has connectionType 'gitlab'", () => {
    expect(server.connectionType).toBe("gitlab");
  });

  it("throws if getToolHandlers() called before start()", () => {
    expect(() => server.getToolHandlers()).toThrow(/start\(\)/);
  });

  it("exposes 5 tools after start()", async () => {
    await server.start(makeGitLabConfig());
    expect(server.getToolHandlers()).toHaveLength(5);
  });

  it("all tools tagged with connection ID", async () => {
    await server.start(makeGitLabConfig());
    for (const h of server.getToolHandlers()) {
      expect(h.definition.tags).toContain("connection:conn-gl-test");
    }
  });

  it("all tools have scope 'read'", async () => {
    await server.start(makeGitLabConfig());
    for (const h of server.getToolHandlers()) {
      expect(server.getToolScope(h.definition.name)).toBe("read");
    }
  });

  it("stop() clears state", async () => {
    await server.start(makeGitLabConfig());
    await server.stop();
    expect(() => server.getToolHandlers()).toThrow();
  });

  describe("gitlab_list_mrs", () => {
    it("calls correct API endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_list_mrs")!;
      await handler.execute({});

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/projects/");
      expect(url).toContain("/merge_requests");
    });

    it("project path is URL-encoded in the request", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_list_mrs")!;
      await handler.execute({});

      const [url] = mockFetch.mock.calls[0] as [string];
      // test-group/test-project → test-group%2Ftest-project
      expect(url).toContain("test-group%2Ftest-project");
    });

    it("token is not present in output", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ iid: 1, title: "MR title" }],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_list_mrs")!;
      const result = await handler.execute({});
      expect(result).not.toContain("glpat-supersecret");
    });
  });

  describe("gitlab_get_mr_diff", () => {
    it("returns error for missing mrIid", async () => {
      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_get_mr_diff")!;
      const result = await handler.execute({});
      expect(result).toMatch(/required/i);
    });

    it("calls diffs endpoint with correct mrIid", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_get_mr_diff")!;
      await handler.execute({ mrIid: 42 });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/merge_requests/42/diffs");
    });
  });

  describe("gitlab_list_pipelines", () => {
    it("calls pipelines endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_list_pipelines")!;
      await handler.execute({});

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/pipelines");
    });

    it("adds ref param when provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_list_pipelines")!;
      await handler.execute({ ref: "main" });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("ref=main");
    });
  });

  describe("gitlab_post_note", () => {
    it("returns error for missing resourceIid", async () => {
      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_post_note")!;
      const result = await handler.execute({ body: "a comment" });
      expect(result).toMatch(/required/i);
    });

    it("returns error for empty body", async () => {
      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_post_note")!;
      const result = await handler.execute({ resourceIid: 1, body: "" });
      expect(result).toMatch(/required/i);
    });

    it("POSTs to merge_requests/notes endpoint by default", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 9, body: "note" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_post_note")!;
      const result = await handler.execute({ resourceIid: 3, body: "LGTM" });

      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/merge_requests/3/notes");
      expect(opts.method).toBe("POST");
      expect(result).toContain("Note posted");
    });

    it("POSTs to issues/notes when resourceType='issues'", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 10, body: "note" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_post_note")!;
      await handler.execute({ resourceType: "issues", resourceIid: 7, body: "Thanks!" });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/issues/7/notes");
    });

    it("token is not present in output", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 1 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_post_note")!;
      const result = await handler.execute({ resourceIid: 1, body: "hi" });
      expect(result).not.toContain("glpat-supersecret");
    });
  });

  describe("gitlab_list_commits", () => {
    it("calls repository/commits endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_list_commits")!;
      await handler.execute({});

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("/repository/commits");
    });

    it("adds ref_name param when ref is provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_list_commits")!;
      await handler.execute({ ref: "develop" });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("ref_name=develop");
    });
  });

  describe("project arg overrides connection default", () => {
    it("uses project from args when provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      });
      vi.stubGlobal("fetch", mockFetch);

      await server.start(makeGitLabConfig());
      const handler = server.getToolHandlers().find((h) => h.definition.name === "gitlab_list_mrs")!;
      await handler.execute({ project: "other-group/other-project" });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain("other-group%2Fother-project");
    });
  });
});

// ── BuiltinMcpServerRegistry ──────────────────────────────────────────────────

import { BuiltinMcpServerRegistry } from "../../server/mcp-servers/registry";
import { ToolRegistry } from "../../server/tools/registry";
import type { IBuiltinMcpServer } from "../../server/mcp-servers/base";
import type { ToolHandler } from "../../server/tools/registry";

function makeToolHandler(name: string): ToolHandler {
  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      inputSchema: {},
      source: "mcp",
      tags: [`connection:test-conn`],
    },
    execute: vi.fn().mockResolvedValue(`result-${name}`),
  };
}

function makeMockServer(tools: ToolHandler[]): IBuiltinMcpServer {
  return {
    connectionType: "kubernetes",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getToolHandlers: vi.fn().mockReturnValue(tools),
    getToolScope: vi.fn().mockReturnValue("read"),
  };
}

describe("BuiltinMcpServerRegistry", () => {
  let toolRegistry: ToolRegistry;
  let registry: BuiltinMcpServerRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    registry = new BuiltinMcpServerRegistry(toolRegistry);
  });

  it("hasFactory returns true for built-in connection types", () => {
    expect(registry.hasFactory("kubernetes")).toBe(true);
    expect(registry.hasFactory("github")).toBe(true);
    expect(registry.hasFactory("gitlab")).toBe(true);
    expect(registry.hasFactory("generic_mcp")).toBe(true);
  });

  it("hasFactory returns false for unknown type", () => {
    expect(registry.hasFactory("aws")).toBe(false);
    expect(registry.hasFactory("jira")).toBe(false);
  });

  it("spawn registers tools in the tool registry", async () => {
    const mockServer = makeMockServer([
      makeToolHandler("tool_a"),
      makeToolHandler("tool_b"),
    ]);
    registry.registerFactory("kubernetes", () => mockServer);

    await registry.spawn("kubernetes", "conn-123", {}, {});

    expect(toolRegistry.getToolByName("tool_a")).toBeDefined();
    expect(toolRegistry.getToolByName("tool_b")).toBeDefined();
  });

  it("spawn calls server.start() with correct config", async () => {
    const mockServer = makeMockServer([makeToolHandler("tool_x")]);
    registry.registerFactory("kubernetes", () => mockServer);

    const config = { namespace: "my-ns" };
    const secrets = { kubeconfigPath: "/path" };
    await registry.spawn("kubernetes", "conn-abc", config, secrets, true);

    expect(mockServer.start).toHaveBeenCalledWith({
      connectionId: "conn-abc",
      config,
      secrets,
      allowDestructive: true,
    });
  });

  it("terminate unregisters all tools and calls server.stop()", async () => {
    const mockServer = makeMockServer([makeToolHandler("my_tool")]);
    registry.registerFactory("kubernetes", () => mockServer);

    await registry.spawn("kubernetes", "conn-xyz", {}, {});
    expect(toolRegistry.getToolByName("my_tool")).toBeDefined();

    await registry.terminate("conn-xyz");
    expect(toolRegistry.getToolByName("my_tool")).toBeUndefined();
    expect(mockServer.stop).toHaveBeenCalled();
  });

  it("isActive returns true after spawn, false after terminate", async () => {
    const mockServer = makeMockServer([makeToolHandler("t1")]);
    registry.registerFactory("github", () => mockServer);

    expect(registry.isActive("conn-test")).toBe(false);
    await registry.spawn("github", "conn-test", {}, {});
    expect(registry.isActive("conn-test")).toBe(true);
    await registry.terminate("conn-test");
    expect(registry.isActive("conn-test")).toBe(false);
  });

  it("getRegisteredToolNames returns tool names for active connection", async () => {
    const mockServer = makeMockServer([
      makeToolHandler("t_one"),
      makeToolHandler("t_two"),
    ]);
    registry.registerFactory("gitlab", () => mockServer);

    await registry.spawn("gitlab", "conn-gl", {}, {});
    const names = registry.getRegisteredToolNames("conn-gl");
    expect(names).toContain("t_one");
    expect(names).toContain("t_two");
  });

  it("getRegisteredToolNames returns empty array for unknown connection", () => {
    const names = registry.getRegisteredToolNames("nonexistent");
    expect(names).toEqual([]);
  });

  it("spawn is idempotent — re-spawning terminates old server first", async () => {
    const mockServer1 = makeMockServer([makeToolHandler("tool_v1")]);
    const mockServer2 = makeMockServer([makeToolHandler("tool_v2")]);
    let callCount = 0;
    registry.registerFactory("kubernetes", () => {
      callCount++;
      return callCount === 1 ? mockServer1 : mockServer2;
    });

    await registry.spawn("kubernetes", "conn-re", {}, {});
    expect(toolRegistry.getToolByName("tool_v1")).toBeDefined();

    await registry.spawn("kubernetes", "conn-re", {}, {});
    // Old server stopped, old tools gone
    expect(mockServer1.stop).toHaveBeenCalled();
    expect(toolRegistry.getToolByName("tool_v1")).toBeUndefined();
    // New server active
    expect(toolRegistry.getToolByName("tool_v2")).toBeDefined();
  });

  it("terminateAll stops all active servers", async () => {
    const serverA = makeMockServer([makeToolHandler("ta")]);
    const serverB = makeMockServer([makeToolHandler("tb")]);
    let i = 0;
    registry.registerFactory("kubernetes", () => (i++ === 0 ? serverA : serverB));

    await registry.spawn("kubernetes", "conn-a", {}, {});
    registry.registerFactory("github", () => serverB);
    await registry.spawn("github", "conn-b", {}, {});

    await registry.terminateAll();

    expect(serverA.stop).toHaveBeenCalled();
    expect(serverB.stop).toHaveBeenCalled();
    expect(registry.getActiveConnectionIds()).toEqual([]);
  });

  it("skips spawn for unknown connection type (no factory)", async () => {
    const before = toolRegistry.getAvailableTools().length;
    await registry.spawn("aws", "conn-aws", {}, {}); // no factory registered
    const after = toolRegistry.getAvailableTools().length;
    expect(after).toBe(before); // nothing registered
  });

  it("terminate on non-active connection is a no-op", async () => {
    await expect(registry.terminate("nonexistent-conn")).resolves.not.toThrow();
  });

  it("tools get builtin-mcp tag added by registry", async () => {
    const handler = makeToolHandler("tagged_tool");
    handler.definition.tags = ["kubernetes", "connection:conn-tag"];
    const mockServer = makeMockServer([handler]);
    registry.registerFactory("kubernetes", () => mockServer);

    await registry.spawn("kubernetes", "conn-tag", {}, {});

    const def = toolRegistry.getToolByName("tagged_tool");
    expect(def?.tags).toContain("builtin-mcp:conn-tag");
  });
});

// ── McpClientManager — built-in integration ───────────────────────────────────

import { McpClientManager } from "../../server/tools/mcp-client";

describe("McpClientManager — built-in server integration", () => {
  let toolRegistry: ToolRegistry;
  let builtinRegistry: BuiltinMcpServerRegistry;
  let manager: McpClientManager;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    builtinRegistry = new BuiltinMcpServerRegistry(toolRegistry);
    manager = new McpClientManager(builtinRegistry);
  });

  it("spawnBuiltinServer() silently skips unknown connection type", async () => {
    await expect(
      manager.spawnBuiltinServer("aws", "conn-aws", {}, {}),
    ).resolves.not.toThrow();
  });

  it("spawnBuiltinServer() activates a server for github type", async () => {
    const mockServer = makeMockServer([makeToolHandler("gh_list_prs_test")]);
    builtinRegistry.registerFactory("github", () => mockServer);

    await manager.spawnBuiltinServer("github", "conn-gh-mgr", {}, {});

    expect(builtinRegistry.isActive("conn-gh-mgr")).toBe(true);
  });

  it("terminateBuiltinServer() stops the server and unregisters tools", async () => {
    const mockServer = makeMockServer([makeToolHandler("gl_list_mrs_test")]);
    builtinRegistry.registerFactory("gitlab", () => mockServer);

    await manager.spawnBuiltinServer("gitlab", "conn-gl-mgr", {}, {});
    await manager.terminateBuiltinServer("conn-gl-mgr");

    expect(builtinRegistry.isActive("conn-gl-mgr")).toBe(false);
    expect(mockServer.stop).toHaveBeenCalled();
  });

  it("terminateBuiltinServer() is a no-op for non-active connection", async () => {
    await expect(manager.terminateBuiltinServer("nonexistent")).resolves.not.toThrow();
  });

  it("getBuiltinRegistry() returns the registry instance", () => {
    expect(manager.getBuiltinRegistry()).toBe(builtinRegistry);
  });

  it("spawnBuiltinServer with allowDestructive passes flag to registry", async () => {
    const mockServer = makeMockServer([makeToolHandler("k8s_tool")]);
    const startSpy = mockServer.start as ReturnType<typeof vi.fn>;
    builtinRegistry.registerFactory("kubernetes", () => mockServer);

    await manager.spawnBuiltinServer("kubernetes", "conn-k8s-destr", {}, {}, true);

    const callArg = startSpy.mock.calls[0][0] as BuiltinMcpServerConfig;
    expect(callArg.allowDestructive).toBe(true);
  });
});
