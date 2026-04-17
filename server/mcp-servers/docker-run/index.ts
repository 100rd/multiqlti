/**
 * Built-in Docker-Run MCP server (issue #270).
 *
 * Wraps the existing SandboxExecutor to expose a single tool:
 *   docker_run — run an arbitrary Docker image with cpu/mem caps
 *
 * The connection config supplies default limits; the tool caller may tighten
 * them but CANNOT exceed the connection's caps.
 *
 * Security:
 *   - CPU and memory are always capped (deny unbounded runs).
 *   - Network is disabled by default unless `networkEnabled` is true on config.
 *   - Secrets (if any) are redacted from stdout/stderr.
 *   - `docker_run_privileged` (run with full privileges) is DESTRUCTIVE.
 */

import type { ToolHandler } from "../../tools/registry";
import type { IBuiltinMcpServer, BuiltinMcpServerConfig, ToolScope } from "../base";
import { redactSecrets, requireDestructiveFlag } from "../base";
import { SandboxExecutor } from "../../sandbox/executor";
import type { SandboxConfig, SandboxFile } from "@shared/types";
import { SANDBOX_DEFAULTS } from "@shared/constants";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard cap on memory to prevent runaway containers. */
const MAX_MEMORY_LIMIT = "2g";
/** Hard cap on CPU fraction (2 cores). */
const MAX_CPU_LIMIT = 2;
/** Hard cap on timeout seconds. */
const MAX_TIMEOUT_SECONDS = 300;

const TOOL_DOCKER_RUN = "docker_run";
const TOOL_DOCKER_RUN_PRIVILEGED = "docker_run_privileged";

const TOOL_SCOPES: Record<string, ToolScope> = {
  [TOOL_DOCKER_RUN]: "read",
  [TOOL_DOCKER_RUN_PRIVILEGED]: "destructive",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a memory limit string (e.g. "512m", "1g") into bytes for comparison.
 * Only supports `m` (megabytes) and `g` (gigabytes) suffixes.
 */
function parseMemoryBytes(mem: string): number {
  const lower = mem.toLowerCase();
  if (lower.endsWith("g")) return parseFloat(lower) * 1024 * 1024 * 1024;
  if (lower.endsWith("m")) return parseFloat(lower) * 1024 * 1024;
  if (lower.endsWith("k")) return parseFloat(lower) * 1024;
  return parseFloat(lower); // assume bytes
}

/**
 * Clamp the caller's memory request to the connection cap and hard cap.
 */
function clampMemory(requested: string, connectionLimit: string): string {
  const reqBytes = parseMemoryBytes(requested);
  const connBytes = parseMemoryBytes(connectionLimit);
  const maxBytes = parseMemoryBytes(MAX_MEMORY_LIMIT);
  const cappedBytes = Math.min(reqBytes, connBytes, maxBytes);
  // Express in MB for readability
  return `${Math.floor(cappedBytes / 1024 / 1024)}m`;
}

// ─── DockerRunMcpServer ───────────────────────────────────────────────────────

export class DockerRunMcpServer implements IBuiltinMcpServer {
  // docker-run is not a real ConnectionType; it maps to a generic_mcp connection
  // that the registry uses as the "docker-run" provider. We use a generic MCP
  // connection to hold docker caps config.
  readonly connectionType = "generic_mcp" as const;

  private cfg: BuiltinMcpServerConfig | null = null;
  private executor: SandboxExecutor;

  constructor(executor?: SandboxExecutor) {
    this.executor = executor ?? new SandboxExecutor();
  }

  async start(cfg: BuiltinMcpServerConfig): Promise<void> {
    this.cfg = cfg;
  }

  async stop(): Promise<void> {
    this.cfg = null;
  }

  getToolScope(toolName: string): ToolScope | undefined {
    return TOOL_SCOPES[toolName];
  }

  getToolHandlers(): ToolHandler[] {
    if (!this.cfg) {
      throw new Error("DockerRunMcpServer: call start() before getToolHandlers()");
    }

    const cfg = this.cfg;
    const connectionMemoryLimit = String(cfg.config["memoryLimit"] ?? SANDBOX_DEFAULTS.memoryLimit);
    const connectionCpuLimit = Math.min(
      Number(cfg.config["cpuLimit"] ?? SANDBOX_DEFAULTS.cpuLimit),
      MAX_CPU_LIMIT,
    );
    const connectionNetworkEnabled = Boolean(cfg.config["networkEnabled"] ?? false);
    const connectionTimeout = Math.min(
      Number(cfg.config["timeout"] ?? SANDBOX_DEFAULTS.timeout),
      MAX_TIMEOUT_SECONDS,
    );
    const executor = this.executor;

    const runContainer = async (
      args: Record<string, unknown>,
      networkOverride?: boolean,
    ): Promise<string> => {
      const image = String(args["image"] ?? "").trim();
      const command = String(args["command"] ?? "sh").trim();
      if (!image) return "Error: image is required.";

      // Clamp caller's limits to connection caps
      const requestedMem = String(args["memoryLimit"] ?? connectionMemoryLimit);
      const requestedCpu = Math.min(
        Number(args["cpuLimit"] ?? connectionCpuLimit),
        connectionCpuLimit,
        MAX_CPU_LIMIT,
      );
      const requestedTimeout = Math.min(
        Number(args["timeout"] ?? connectionTimeout),
        connectionTimeout,
        MAX_TIMEOUT_SECONDS,
      );

      const sandboxConfig: SandboxConfig = {
        enabled: true,
        image,
        command,
        memoryLimit: clampMemory(requestedMem, connectionMemoryLimit),
        cpuLimit: requestedCpu,
        networkEnabled: networkOverride !== undefined ? networkOverride : connectionNetworkEnabled,
        timeout: requestedTimeout,
        env: args["env"] ? (args["env"] as Record<string, string>) : undefined,
        installCommand: args["installCommand"] ? String(args["installCommand"]) : undefined,
        workdir: args["workdir"] ? String(args["workdir"]) : undefined,
      };

      const files: SandboxFile[] = Array.isArray(args["files"])
        ? (args["files"] as Array<{ path: string; content: string }>).map((f) => ({
            path: f.path,
            content: f.content,
          }))
        : [];

      const result = await executor.execute(sandboxConfig, files);

      const lines: string[] = [
        `Exit code: ${result.exitCode}`,
        `Duration: ${result.durationMs}ms`,
        `Memory limit: ${sandboxConfig.memoryLimit}`,
        `CPU limit: ${sandboxConfig.cpuLimit}`,
      ];
      if (result.timedOut) lines.push("Status: TIMED_OUT");
      if (result.stdout) lines.push(`\nstdout:\n${result.stdout}`);
      if (result.stderr) lines.push(`\nstderr:\n${result.stderr}`);

      const output = lines.join("\n");
      return redactSecrets(output, cfg.secrets);
    };

    return [
      // ── docker_run ─────────────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_DOCKER_RUN,
          description:
            "Run a Docker image in a sandboxed container with CPU/memory caps. " +
            "Network is disabled by default (controlled by connection config).",
          inputSchema: {
            type: "object",
            properties: {
              image: {
                type: "string",
                description: "Docker image to run (e.g. \"python:3.12-slim\").",
              },
              command: {
                type: "string",
                description: "Shell command to execute inside the container.",
              },
              memoryLimit: {
                type: "string",
                description:
                  `Memory limit (e.g. "512m", "1g"). Capped at connection limit (${connectionMemoryLimit}).`,
              },
              cpuLimit: {
                type: "number",
                description:
                  `CPU fraction (e.g. 0.5 = half a core). Capped at connection limit (${connectionCpuLimit}).`,
              },
              timeout: {
                type: "number",
                description:
                  `Timeout in seconds. Capped at connection limit (${connectionTimeout}).`,
              },
              files: {
                type: "array",
                description: "Files to write into the workdir before running.",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                  },
                  required: ["path", "content"],
                },
              },
              env: {
                type: "object",
                description: "Environment variables to set inside the container.",
                additionalProperties: { type: "string" },
              },
              installCommand: {
                type: "string",
                description: "Command to run before the main command (e.g. \"pip install -r requirements.txt\").",
              },
              workdir: {
                type: "string",
                description: "Working directory inside the container.",
              },
            },
            required: ["image", "command"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:docker-run:${cfg.connectionId}`,
          tags: ["docker", `connection:${cfg.connectionId}`],
        },
        execute: (args) => runContainer(args),
      },

      // ── docker_run_privileged ──────────────────────────────────────────────
      {
        definition: {
          name: TOOL_DOCKER_RUN_PRIVILEGED,
          description:
            "Run a Docker image with network access enabled. " +
            "DESTRUCTIVE — requires allowDestructive=true on the connection.",
          inputSchema: {
            type: "object",
            properties: {
              image: { type: "string", description: "Docker image to run." },
              command: { type: "string", description: "Command to execute." },
              memoryLimit: { type: "string" },
              cpuLimit: { type: "number" },
              timeout: { type: "number" },
              files: { type: "array", items: { type: "object" } },
              env: { type: "object", additionalProperties: { type: "string" } },
              installCommand: { type: "string" },
              workdir: { type: "string" },
            },
            required: ["image", "command"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:docker-run:${cfg.connectionId}`,
          tags: ["docker", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          requireDestructiveFlag(TOOL_DOCKER_RUN_PRIVILEGED, cfg.allowDestructive);
          return runContainer(args, true /* networkEnabled */);
        },
      },
    ];
  }
}
