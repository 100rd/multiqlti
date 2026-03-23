import { BaseAgent } from "../base-agent.js";

export class TriageAgent extends BaseAgent {
  constructor() {
    super({
      name: "triage-agent",
      description: "Automated incident triage — pod, deployment, and node diagnosis with failure tolerance",
      version: "0.1.0",
      port: parseInt(process.env.AGENT_PORT ?? "8084", 10),
    });
  }

  protected setupTools(): void {
    const ns = process.env.AGENT_NAMESPACE ?? "default";

    this.registerTool({
      name: "triage_pod",
      description: "Collect diagnostic data for a pod (describe, logs, previous logs, events)",
      inputSchema: {
        type: "object",
        properties: {
          pod: { type: "string", description: "Pod name" },
          namespace: { type: "string", description: "Namespace override" },
        },
        required: ["pod"],
      },
      handler: async (input) => {
        const pod = input.pod as string;
        const targetNs = (input.namespace as string) ?? ns;
        const sections: string[] = [];

        // kubectl describe pod
        try {
          const result = await this.exec("kubectl", ["describe", "pod", pod, "-n", targetNs]);
          sections.push(`=== DESCRIBE POD ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== DESCRIBE POD ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl logs (last 100 lines)
        try {
          const result = await this.exec("kubectl", ["logs", pod, "-n", targetNs, "--tail", "100"]);
          sections.push(`=== LOGS (last 100) ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== LOGS (last 100) ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl logs --previous
        try {
          const result = await this.exec("kubectl", ["logs", pod, "-n", targetNs, "--previous", "--tail", "100"]);
          sections.push(`=== PREVIOUS LOGS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== PREVIOUS LOGS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl get events
        try {
          const result = await this.exec("kubectl", [
            "get", "events", "-n", targetNs,
            "--field-selector", `involvedObject.name=${pod}`,
            "--sort-by", ".lastTimestamp",
          ]);
          sections.push(`=== EVENTS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== EVENTS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        return { content: sections.join("\n\n") };
      },
    });

    this.registerTool({
      name: "triage_deployment",
      description: "Collect diagnostic data for a deployment (rollout status, describe, replicasets, pods, events)",
      inputSchema: {
        type: "object",
        properties: {
          deployment: { type: "string", description: "Deployment name" },
          namespace: { type: "string", description: "Namespace override" },
        },
        required: ["deployment"],
      },
      handler: async (input) => {
        const deployment = input.deployment as string;
        const targetNs = (input.namespace as string) ?? ns;
        const sections: string[] = [];

        // kubectl rollout status
        try {
          const result = await this.exec("kubectl", [
            "rollout", "status", `deployment/${deployment}`, "-n", targetNs,
          ]);
          sections.push(`=== ROLLOUT STATUS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== ROLLOUT STATUS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl describe deployment
        try {
          const result = await this.exec("kubectl", ["describe", "deployment", deployment, "-n", targetNs]);
          sections.push(`=== DESCRIBE DEPLOYMENT ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== DESCRIBE DEPLOYMENT ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl get replicasets for this deployment
        try {
          const result = await this.exec("kubectl", [
            "get", "rs", "-n", targetNs, "-l", `app=${deployment}`,
          ]);
          sections.push(`=== REPLICASETS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== REPLICASETS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl get pods with label selector
        try {
          const result = await this.exec("kubectl", [
            "get", "pods", "-n", targetNs, "-l", `app=${deployment}`,
          ]);
          sections.push(`=== PODS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== PODS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl get events
        try {
          const result = await this.exec("kubectl", [
            "get", "events", "-n", targetNs,
            "--field-selector", `involvedObject.name=${deployment}`,
            "--sort-by", ".lastTimestamp",
          ]);
          sections.push(`=== EVENTS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== EVENTS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        return { content: sections.join("\n\n") };
      },
    });

    this.registerTool({
      name: "triage_node",
      description: "Collect diagnostic data for a node (describe, pod metrics, events)",
      inputSchema: {
        type: "object",
        properties: {
          node: { type: "string", description: "Node name" },
        },
        required: ["node"],
      },
      handler: async (input) => {
        const node = input.node as string;
        const sections: string[] = [];

        // kubectl describe node
        try {
          const result = await this.exec("kubectl", ["describe", "node", node]);
          sections.push(`=== DESCRIBE NODE ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== DESCRIBE NODE ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl top pods on that node
        try {
          const result = await this.exec("kubectl", [
            "top", "pods", "--all-namespaces", "--field-selector", `spec.nodeName=${node}`,
          ]);
          sections.push(`=== POD METRICS ON NODE ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== POD METRICS ON NODE ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        // kubectl get events for node
        try {
          const result = await this.exec("kubectl", [
            "get", "events", "--all-namespaces",
            "--field-selector", `involvedObject.name=${node}`,
            "--sort-by", ".lastTimestamp",
          ]);
          sections.push(`=== NODE EVENTS ===\n${result.content}`);
        } catch (err: unknown) {
          sections.push(`=== NODE EVENTS ===\nError: ${err instanceof Error ? err.message : String(err)}`);
        }

        return { content: sections.join("\n\n") };
      },
    });

    this.registerTool({
      name: "check_endpoints",
      description: "HTTP probe an array of URLs and return status code + latency for each",
      inputSchema: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            description: "Array of URLs to probe",
          },
        },
        required: ["urls"],
      },
      handler: async (input) => {
        const urls = (input.urls as string[]) ?? [];
        const results: string[] = [];

        for (const url of urls) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const start = Date.now();
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            const latency = Date.now() - start;
            results.push(`${url} -> ${res.status} (${latency}ms)`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push(`${url} -> ERROR: ${msg}`);
          }
        }

        return { content: results.join("\n") };
      },
    });
  }
}
