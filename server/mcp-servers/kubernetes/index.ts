/**
 * Built-in Kubernetes MCP server (issue #270).
 *
 * Tools exposed:
 *   k8s_deploy_manifest      — apply a YAML manifest to the run namespace
 *   k8s_apply_helm_chart     — install/upgrade a Helm release in the run namespace
 *   k8s_port_forward_check   — port-forward a pod and perform a basic HTTP health check
 *   k8s_get_logs             — tail N lines of pod logs
 *   k8s_delete_namespace     — delete the run namespace (DESTRUCTIVE)
 *
 * Namespace scoping: every tool is scoped to `cfg.config.namespace`.
 *
 * Security:
 *   - kubeconfig / token secrets are never included in tool output.
 *   - `k8s_delete_namespace` requires `allowDestructive=true`.
 *   - All commands run via `child_process.spawn` — no shell interpolation.
 */

import { spawn } from "child_process";
import type { ToolHandler } from "../../tools/registry";
import type { IBuiltinMcpServer, BuiltinMcpServerConfig, ToolScope } from "../base";
import { redactSecrets, requireDestructiveFlag } from "../base";

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCommand(
  cmd: string,
  args: string[],
  stdinData?: string,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout, stderr: err.message, exitCode: 1 }));
    if (stdinData !== undefined) {
      proc.stdin.write(stdinData);
    }
    proc.stdin.end();
  });
}

function kubectlArgs(kubeconfigPath: string | undefined, ...rest: string[]): string[] {
  return kubeconfigPath ? ["--kubeconfig", kubeconfigPath, ...rest] : [...rest];
}

function helmArgs(kubeconfigPath: string | undefined, ...rest: string[]): string[] {
  return kubeconfigPath ? ["--kubeconfig", kubeconfigPath, ...rest] : [...rest];
}

function validateNamespace(ns: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,251}[a-z0-9]$|^[a-z0-9]$/.test(ns)) {
    throw new Error(
      `Invalid namespace "${ns}". Must match Kubernetes naming rules.`,
    );
  }
  return ns;
}

function formatResult(result: SpawnResult): string {
  if (result.exitCode === 0) return result.stdout || "(no output)";
  return `Error (exit ${result.exitCode}): ${result.stderr || result.stdout}`;
}

// ─── Tool name constants ──────────────────────────────────────────────────────

const TOOL_DEPLOY_MANIFEST = "k8s_deploy_manifest";
const TOOL_APPLY_HELM = "k8s_apply_helm_chart";
const TOOL_PORT_FORWARD_CHECK = "k8s_port_forward_check";
const TOOL_GET_LOGS = "k8s_get_logs";
const TOOL_DELETE_NAMESPACE = "k8s_delete_namespace";

const TOOL_SCOPES: Record<string, ToolScope> = {
  [TOOL_DEPLOY_MANIFEST]: "read",
  [TOOL_APPLY_HELM]: "read",
  [TOOL_PORT_FORWARD_CHECK]: "read",
  [TOOL_GET_LOGS]: "read",
  [TOOL_DELETE_NAMESPACE]: "destructive",
};

// ─── KubernetesMcpServer ──────────────────────────────────────────────────────

export class KubernetesMcpServer implements IBuiltinMcpServer {
  readonly connectionType = "kubernetes" as const;

  private cfg: BuiltinMcpServerConfig | null = null;
  private namespace = "default";
  private kubeconfigPath: string | undefined = undefined;

  async start(cfg: BuiltinMcpServerConfig): Promise<void> {
    this.cfg = cfg;
    const rawNs = String(cfg.config["namespace"] ?? "default");
    this.namespace = validateNamespace(rawNs);
    this.kubeconfigPath = cfg.secrets["kubeconfigPath"] ?? undefined;
  }

  async stop(): Promise<void> {
    this.cfg = null;
  }

  getToolScope(toolName: string): ToolScope | undefined {
    return TOOL_SCOPES[toolName];
  }

  getToolHandlers(): ToolHandler[] {
    if (!this.cfg) {
      throw new Error("KubernetesMcpServer: call start() before getToolHandlers()");
    }

    const cfg = this.cfg;
    const ns = this.namespace;
    const kc = this.kubeconfigPath;

    return [
      // ── k8s_deploy_manifest ────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_DEPLOY_MANIFEST,
          description:
            "Apply a Kubernetes YAML manifest to the scoped namespace. " +
            "Returns kubectl apply output.",
          inputSchema: {
            type: "object",
            properties: {
              manifest: {
                type: "string",
                description: "YAML manifest content to apply.",
              },
            },
            required: ["manifest"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:kubernetes:${cfg.connectionId}`,
          tags: ["kubernetes", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const manifest = String(args["manifest"] ?? "");
          if (!manifest.trim()) return "Error: manifest is empty.";

          const result = await runCommand(
            "kubectl",
            kubectlArgs(kc, "apply", "--namespace", ns, "-f", "-"),
            manifest,
          );
          return redactSecrets(formatResult(result), cfg.secrets);
        },
      },

      // ── k8s_apply_helm_chart ───────────────────────────────────────────────
      {
        definition: {
          name: TOOL_APPLY_HELM,
          description:
            "Install or upgrade a Helm chart in the scoped namespace. " +
            "Returns helm upgrade output.",
          inputSchema: {
            type: "object",
            properties: {
              releaseName: { type: "string", description: "Helm release name." },
              chart: {
                type: "string",
                description: "Chart reference (repo/chart or local path).",
              },
              valuesYaml: {
                type: "string",
                description: "Optional Helm values as YAML string.",
              },
              version: {
                type: "string",
                description: "Optional chart version.",
              },
            },
            required: ["releaseName", "chart"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:kubernetes:${cfg.connectionId}`,
          tags: ["kubernetes", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const releaseName = String(args["releaseName"] ?? "").trim();
          const chart = String(args["chart"] ?? "").trim();
          if (!releaseName || !chart) {
            return "Error: releaseName and chart are required.";
          }

          const baseArgs = [
            "upgrade", "--install",
            releaseName, chart,
            "--namespace", ns,
            "--create-namespace",
          ];

          if (args["version"]) baseArgs.push("--version", String(args["version"]));

          const valuesYaml = args["valuesYaml"] ? String(args["valuesYaml"]) : undefined;
          if (valuesYaml) baseArgs.push("-f", "-");

          const result = await runCommand(
            "helm",
            helmArgs(kc, ...baseArgs),
            valuesYaml,
          );
          return redactSecrets(formatResult(result), cfg.secrets);
        },
      },

      // ── k8s_port_forward_check ─────────────────────────────────────────────
      {
        definition: {
          name: TOOL_PORT_FORWARD_CHECK,
          description:
            "Start a kubectl port-forward for a pod and perform an HTTP health check. " +
            "Returns health status and response body.",
          inputSchema: {
            type: "object",
            properties: {
              podName: { type: "string", description: "Pod name to port-forward." },
              targetPort: {
                type: "number",
                description: "Container port to forward.",
              },
              healthPath: {
                type: "string",
                description: "HTTP path for health check (default: \"/health\").",
              },
            },
            required: ["podName", "targetPort"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:kubernetes:${cfg.connectionId}`,
          tags: ["kubernetes", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const podName = String(args["podName"] ?? "").trim();
          const targetPort = Number(args["targetPort"] ?? 0);
          const healthPath = String(args["healthPath"] ?? "/health");

          if (!podName || targetPort <= 0) {
            return "Error: podName and a positive targetPort are required.";
          }

          // Use a local port above 30000 to avoid privilege requirements
          const localPort = 30000 + (targetPort % 10000);

          const pfArgs = kubectlArgs(
            kc,
            "port-forward", `pod/${podName}`,
            `${localPort}:${targetPort}`,
            "--namespace", ns,
          );

          const pfProc = spawn("kubectl", pfArgs, { stdio: ["ignore", "pipe", "pipe"] });

          try {
            // Wait for the port-forward to become ready
            await new Promise<void>((resolve) => setTimeout(resolve, 1500));

            const curlResult = await runCommand("curl", [
              "-sf", "--max-time", "5",
              `http://localhost:${localPort}${healthPath}`,
            ]);

            const status = curlResult.exitCode === 0 ? "HEALTHY" : "UNHEALTHY";
            const body = curlResult.stdout.trim() || curlResult.stderr.trim() || "(empty)";
            return redactSecrets(
              `Status: ${status}\nPod: ${podName}\nPath: ${healthPath}\nResponse: ${body}`,
              cfg.secrets,
            );
          } finally {
            pfProc.kill("SIGTERM");
          }
        },
      },

      // ── k8s_get_logs ──────────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_GET_LOGS,
          description:
            "Fetch the last N lines of logs from a pod in the scoped namespace.",
          inputSchema: {
            type: "object",
            properties: {
              podName: { type: "string", description: "Pod name." },
              containerName: {
                type: "string",
                description: "Container name (needed for multi-container pods).",
              },
              tail: {
                type: "number",
                description: "Number of lines to return (default: 100, max: 1000).",
              },
            },
            required: ["podName"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:kubernetes:${cfg.connectionId}`,
          tags: ["kubernetes", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const podName = String(args["podName"] ?? "").trim();
          if (!podName) return "Error: podName is required.";

          const tail = Math.min(Number(args["tail"] ?? 100), 1000);
          const logArgs = ["logs", podName, "--namespace", ns, `--tail=${tail}`];
          if (args["containerName"]) logArgs.push("-c", String(args["containerName"]));

          const result = await runCommand("kubectl", kubectlArgs(kc, ...logArgs));
          return redactSecrets(formatResult(result), cfg.secrets);
        },
      },

      // ── k8s_delete_namespace ──────────────────────────────────────────────
      {
        definition: {
          name: TOOL_DELETE_NAMESPACE,
          description:
            "Delete the scoped namespace and all resources within it. " +
            "DESTRUCTIVE — requires allowDestructive=true on the connection.",
          inputSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "string",
                description: "Must be \"DELETE\" to confirm the destructive operation.",
              },
            },
            required: ["confirm"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:kubernetes:${cfg.connectionId}`,
          tags: ["kubernetes", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          requireDestructiveFlag(TOOL_DELETE_NAMESPACE, cfg.allowDestructive);

          if (String(args["confirm"]) !== "DELETE") {
            return 'Error: confirm must be the string "DELETE" to proceed.';
          }

          const result = await runCommand(
            "kubectl",
            kubectlArgs(kc, "delete", "namespace", ns, "--ignore-not-found"),
          );
          const output = result.exitCode === 0
            ? `Namespace "${ns}" deleted.\n${result.stdout}`
            : formatResult(result);
          return redactSecrets(output, cfg.secrets);
        },
      },
    ];
  }
}
