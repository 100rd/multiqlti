import { BaseAgent } from "../base-agent.js";

export class K8sAgent extends BaseAgent {
  constructor() {
    super({
      name: "k8s-agent",
      description: "Kubernetes cluster operations — pods, deployments, services, logs",
      version: "0.1.0",
      port: parseInt(process.env.AGENT_PORT ?? "8080", 10),
    });
  }

  protected setupTools(): void {
    const ns = process.env.AGENT_NAMESPACE ?? "default";

    this.registerTool({
      name: "kubectl_get",
      description: "Get Kubernetes resources (pods, deployments, services, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string", description: "Resource type (pods, deployments, services, etc.)" },
          name: { type: "string", description: "Specific resource name (optional)" },
          namespace: { type: "string", description: "Namespace override" },
          selector: { type: "string", description: "Label selector (e.g. app=myapp)" },
          output: { type: "string", enum: ["json", "yaml", "wide", "name"], description: "Output format" },
        },
        required: ["resource"],
      },
      handler: async (input) => {
        const args = ["get", input.resource as string];
        if (input.name) args.push(input.name as string);
        args.push("-n", (input.namespace as string) ?? ns);
        if (input.selector) args.push("-l", input.selector as string);
        args.push("-o", (input.output as string) ?? "json");
        return this.exec("kubectl", args);
      },
    });

    this.registerTool({
      name: "kubectl_apply",
      description: "Apply a Kubernetes manifest (YAML/JSON)",
      inputSchema: {
        type: "object",
        properties: {
          manifest: { type: "string", description: "YAML or JSON manifest content" },
          namespace: { type: "string" },
          dryRun: { type: "boolean", description: "Dry-run mode (client or server)" },
        },
        required: ["manifest"],
      },
      handler: async (input) => {
        const args = ["apply", "-f", "-", "-n", (input.namespace as string) ?? ns];
        if (input.dryRun) args.push("--dry-run=client");
        args.push("-o", "json");
        return this.execWithStdin("kubectl", args, input.manifest as string);
      },
    });

    this.registerTool({
      name: "kubectl_delete",
      description: "Delete Kubernetes resources",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string" },
          name: { type: "string" },
          namespace: { type: "string" },
        },
        required: ["resource", "name"],
      },
      handler: async (input) => {
        const args = [
          "delete",
          input.resource as string,
          input.name as string,
          "-n",
          (input.namespace as string) ?? ns,
        ];
        return this.exec("kubectl", args);
      },
    });

    this.registerTool({
      name: "kubectl_logs",
      description: "Get pod logs",
      inputSchema: {
        type: "object",
        properties: {
          pod: { type: "string" },
          namespace: { type: "string" },
          container: { type: "string" },
          tail: { type: "number", description: "Number of lines" },
          since: { type: "string", description: "Duration (e.g. 1h, 30m)" },
          previous: { type: "boolean" },
        },
        required: ["pod"],
      },
      handler: async (input) => {
        const args = ["logs", input.pod as string, "-n", (input.namespace as string) ?? ns];
        if (input.container) args.push("-c", input.container as string);
        if (input.tail) args.push("--tail", String(input.tail));
        if (input.since) args.push("--since", input.since as string);
        if (input.previous) args.push("--previous");
        return this.exec("kubectl", args);
      },
    });

    this.registerTool({
      name: "kubectl_rollout_status",
      description: "Check deployment rollout status",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string", description: "e.g. deployment/myapp" },
          namespace: { type: "string" },
          timeout: { type: "string", description: "e.g. 120s" },
        },
        required: ["resource"],
      },
      handler: async (input) => {
        const args = ["rollout", "status", input.resource as string, "-n", (input.namespace as string) ?? ns];
        if (input.timeout) args.push("--timeout", input.timeout as string);
        return this.exec("kubectl", args);
      },
    });

    this.registerTool({
      name: "kubectl_describe",
      description: "Describe a Kubernetes resource",
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string" },
          name: { type: "string" },
          namespace: { type: "string" },
        },
        required: ["resource", "name"],
      },
      handler: async (input) => {
        const args = [
          "describe",
          input.resource as string,
          input.name as string,
          "-n",
          (input.namespace as string) ?? ns,
        ];
        return this.exec("kubectl", args);
      },
    });

    this.registerTool({
      name: "kubectl_exec",
      description: "Execute a command inside a pod",
      inputSchema: {
        type: "object",
        properties: {
          pod: { type: "string" },
          command: { type: "string", description: "Command to run" },
          container: { type: "string" },
          namespace: { type: "string" },
        },
        required: ["pod", "command"],
      },
      handler: async (input) => {
        const args = ["exec", input.pod as string, "-n", (input.namespace as string) ?? ns];
        if (input.container) args.push("-c", input.container as string);
        args.push("--", "sh", "-c", input.command as string);
        return this.exec("kubectl", args);
      },
    });
  }
}
