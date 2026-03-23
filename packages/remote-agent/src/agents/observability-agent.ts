import * as os from "node:os";
import { BaseAgent } from "../base-agent.js";

export class ObservabilityAgent extends BaseAgent {
  constructor() {
    super({
      name: "observability-agent",
      description: "Monitoring and observability — Prometheus queries, Loki logs, resource metrics",
      version: "0.1.0",
      port: parseInt(process.env.AGENT_PORT ?? "8082", 10),
    });
  }

  protected setupTools(): void {
    const prometheusUrl = process.env.PROMETHEUS_URL ?? "http://prometheus:9090";
    const lokiUrl = process.env.LOKI_URL ?? "http://loki:3100";
    const ns = process.env.AGENT_NAMESPACE ?? "default";

    this.registerTool({
      name: "prometheus_query",
      description: "Execute a PromQL query against Prometheus",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "PromQL query expression" },
          time: { type: "string", description: "Evaluation timestamp (RFC3339 or unix)" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const params = new URLSearchParams({ query: input.query as string });
        if (input.time) params.set("time", input.time as string);
        const url = `${prometheusUrl}/api/v1/query?${params.toString()}`;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          const body = await res.text();
          return { content: body };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Error: ${msg}` };
        }
      },
    });

    this.registerTool({
      name: "loki_query",
      description: "Query logs from Loki",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "LogQL query expression" },
          limit: { type: "number", description: "Maximum number of entries to return" },
          direction: { type: "string", enum: ["forward", "backward"], description: "Sort direction" },
          start: { type: "string", description: "Start timestamp (RFC3339 or unix nanoseconds)" },
          end: { type: "string", description: "End timestamp (RFC3339 or unix nanoseconds)" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const params = new URLSearchParams({ query: input.query as string });
        if (input.limit != null) params.set("limit", String(input.limit));
        if (input.direction) params.set("direction", input.direction as string);
        if (input.start) params.set("start", input.start as string);
        if (input.end) params.set("end", input.end as string);
        const url = `${lokiUrl}/loki/api/v1/query_range?${params.toString()}`;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);
          const body = await res.text();
          return { content: body };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Error: ${msg}` };
        }
      },
    });

    this.registerTool({
      name: "pod_metrics",
      description: "Get pod resource usage metrics via kubectl top",
      inputSchema: {
        type: "object",
        properties: {
          namespace: { type: "string", description: "Namespace override" },
          sortBy: { type: "string", enum: ["cpu", "memory"], description: "Sort by resource" },
        },
      },
      handler: async (input) => {
        const targetNs = (input.namespace as string) ?? ns;
        const sortBy = (input.sortBy as string) ?? "cpu";
        return this.exec("kubectl", ["top", "pods", "-n", targetNs, `--sort-by=${sortBy}`]);
      },
    });

    this.registerTool({
      name: "node_metrics",
      description: "Get node resource usage metrics via kubectl top",
      inputSchema: {
        type: "object",
        properties: {
          sortBy: { type: "string", enum: ["cpu", "memory"], description: "Sort by resource" },
        },
      },
      handler: async (input) => {
        const sortBy = (input.sortBy as string) ?? "cpu";
        return this.exec("kubectl", ["top", "nodes", `--sort-by=${sortBy}`]);
      },
    });

    this.registerTool({
      name: "system_info",
      description: "Get system information (CPUs, memory, uptime, load average)",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const info = {
          cpus: os.cpus(),
          totalMemory: os.totalmem(),
          freeMemory: os.freemem(),
          uptime: os.uptime(),
          loadAverage: os.loadavg(),
        };
        return { content: JSON.stringify(info, null, 2) };
      },
    });
  }
}
