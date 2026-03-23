import { BaseAgent } from "../base-agent.js";

export class HelmAgent extends BaseAgent {
  constructor() {
    super({
      name: "helm-agent",
      description: "Helm chart management — install, upgrade, rollback, status, history",
      version: "0.1.0",
      port: parseInt(process.env.AGENT_PORT ?? "8081", 10),
    });
  }

  protected setupTools(): void {
    const ns = process.env.AGENT_NAMESPACE ?? "default";

    this.registerTool({
      name: "helm_list",
      description: "List Helm releases",
      inputSchema: {
        type: "object",
        properties: {
          namespace: { type: "string", description: "Namespace override" },
          allNamespaces: { type: "boolean", description: "List across all namespaces" },
          filter: { type: "string", description: "Filter releases by name regex" },
          output: { type: "string", enum: ["json", "yaml", "table"], description: "Output format" },
        },
      },
      handler: async (input) => {
        const args = ["list"];
        if (input.allNamespaces) {
          args.push("--all-namespaces");
        } else {
          args.push("-n", (input.namespace as string) ?? ns);
        }
        if (input.filter) args.push("--filter", input.filter as string);
        args.push("-o", (input.output as string) ?? "json");
        return this.exec("helm", args);
      },
    });

    this.registerTool({
      name: "helm_install",
      description: "Install a Helm chart",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string", description: "Release name" },
          chart: { type: "string", description: "Chart reference (repo/chart or path)" },
          namespace: { type: "string" },
          values: { type: "string", description: "YAML values to pass (inline)" },
          set: {
            type: "array",
            items: { type: "string" },
            description: "Individual value overrides (key=value)",
          },
          version: { type: "string", description: "Chart version constraint" },
          dryRun: { type: "boolean", description: "Simulate install" },
          wait: { type: "boolean", description: "Wait for resources to be ready" },
          timeout: { type: "string", description: "Timeout for wait (e.g. 5m0s)" },
          createNamespace: { type: "boolean", description: "Create namespace if missing" },
        },
        required: ["release", "chart"],
      },
      handler: async (input) => {
        const args = ["install", input.release as string, input.chart as string];
        args.push("-n", (input.namespace as string) ?? ns);
        if (input.version) args.push("--version", input.version as string);
        if (input.dryRun) args.push("--dry-run");
        if (input.wait) args.push("--wait");
        if (input.timeout) args.push("--timeout", input.timeout as string);
        if (input.createNamespace) args.push("--create-namespace");
        if (input.set && Array.isArray(input.set)) {
          for (const s of input.set) {
            args.push("--set", s as string);
          }
        }
        args.push("-o", "json");

        if (input.values) {
          return this.execWithStdin("helm", [...args, "-f", "-"], input.values as string);
        }
        return this.exec("helm", args);
      },
    });

    this.registerTool({
      name: "helm_upgrade",
      description: "Upgrade a Helm release",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string", description: "Release name" },
          chart: { type: "string", description: "Chart reference" },
          namespace: { type: "string" },
          values: { type: "string", description: "YAML values (inline)" },
          set: {
            type: "array",
            items: { type: "string" },
            description: "Individual value overrides (key=value)",
          },
          version: { type: "string", description: "Chart version constraint" },
          reuseValues: { type: "boolean", description: "Reuse existing values" },
          resetValues: { type: "boolean", description: "Reset to chart defaults" },
          dryRun: { type: "boolean", description: "Simulate upgrade" },
          wait: { type: "boolean", description: "Wait for resources to be ready" },
          timeout: { type: "string", description: "Timeout for wait" },
          install: { type: "boolean", description: "Install if release does not exist" },
        },
        required: ["release", "chart"],
      },
      handler: async (input) => {
        const args = ["upgrade", input.release as string, input.chart as string];
        args.push("-n", (input.namespace as string) ?? ns);
        if (input.version) args.push("--version", input.version as string);
        if (input.reuseValues) args.push("--reuse-values");
        if (input.resetValues) args.push("--reset-values");
        if (input.dryRun) args.push("--dry-run");
        if (input.wait) args.push("--wait");
        if (input.timeout) args.push("--timeout", input.timeout as string);
        if (input.install) args.push("--install");
        if (input.set && Array.isArray(input.set)) {
          for (const s of input.set) {
            args.push("--set", s as string);
          }
        }
        args.push("-o", "json");

        if (input.values) {
          return this.execWithStdin("helm", [...args, "-f", "-"], input.values as string);
        }
        return this.exec("helm", args);
      },
    });

    this.registerTool({
      name: "helm_rollback",
      description: "Rollback a Helm release to a previous revision",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string", description: "Release name" },
          revision: { type: "number", description: "Revision number to rollback to" },
          namespace: { type: "string" },
          wait: { type: "boolean", description: "Wait for rollback to complete" },
          timeout: { type: "string", description: "Timeout for wait" },
          dryRun: { type: "boolean", description: "Simulate rollback" },
        },
        required: ["release"],
      },
      handler: async (input) => {
        const args = ["rollback", input.release as string];
        if (input.revision != null) args.push(String(input.revision));
        args.push("-n", (input.namespace as string) ?? ns);
        if (input.wait) args.push("--wait");
        if (input.timeout) args.push("--timeout", input.timeout as string);
        if (input.dryRun) args.push("--dry-run");
        return this.exec("helm", args);
      },
    });

    this.registerTool({
      name: "helm_status",
      description: "Show the status of a Helm release",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string", description: "Release name" },
          namespace: { type: "string" },
          revision: { type: "number", description: "Specific revision to check" },
          output: { type: "string", enum: ["json", "yaml", "table"], description: "Output format" },
        },
        required: ["release"],
      },
      handler: async (input) => {
        const args = ["status", input.release as string];
        args.push("-n", (input.namespace as string) ?? ns);
        if (input.revision != null) args.push("--revision", String(input.revision));
        args.push("-o", (input.output as string) ?? "json");
        return this.exec("helm", args);
      },
    });

    this.registerTool({
      name: "helm_history",
      description: "Show release history (revisions)",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string", description: "Release name" },
          namespace: { type: "string" },
          max: { type: "number", description: "Maximum number of revisions to return" },
          output: { type: "string", enum: ["json", "yaml", "table"], description: "Output format" },
        },
        required: ["release"],
      },
      handler: async (input) => {
        const args = ["history", input.release as string];
        args.push("-n", (input.namespace as string) ?? ns);
        if (input.max != null) args.push("--max", String(input.max));
        args.push("-o", (input.output as string) ?? "json");
        return this.exec("helm", args);
      },
    });

    this.registerTool({
      name: "helm_values",
      description: "Show computed values for a release",
      inputSchema: {
        type: "object",
        properties: {
          release: { type: "string", description: "Release name" },
          namespace: { type: "string" },
          all: { type: "boolean", description: "Show all values (computed + default)" },
          revision: { type: "number", description: "Specific revision" },
          output: { type: "string", enum: ["json", "yaml", "table"], description: "Output format" },
        },
        required: ["release"],
      },
      handler: async (input) => {
        const args = ["get", "values", input.release as string];
        args.push("-n", (input.namespace as string) ?? ns);
        if (input.all) args.push("--all");
        if (input.revision != null) args.push("--revision", String(input.revision));
        args.push("-o", (input.output as string) ?? "json");
        return this.exec("helm", args);
      },
    });
  }
}
