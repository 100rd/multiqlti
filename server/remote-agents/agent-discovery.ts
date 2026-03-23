import { A2AClient } from "./a2a-client";
import type { AgentCard, RemoteAgentConfig, RemoteAgentStatus } from "@shared/types";

// ─── Discovery Types ─────────────────────────────────────────────────────────

export interface DiscoveryResult {
  endpoint: string;
  agentCard: AgentCard;
  transport: string;
}

export interface HealthCheckResult {
  status: RemoteAgentStatus;
  error?: string;
  agentCard?: AgentCard;
  latencyMs: number;
}

// ─── K8s API Response Shape ──────────────────────────────────────────────────

interface K8sServicePort {
  name: string;
  port: number;
}

interface K8sServiceItem {
  metadata: { name: string; namespace: string };
  spec: { ports: K8sServicePort[] };
}

interface K8sServiceList {
  items: K8sServiceItem[];
}

// ─── Service ─────────────────────────────────────────────────────────────────

const DISCOVERY_TIMEOUT_MS = 10_000;

export class AgentDiscoveryService {
  /**
   * Probe a single endpoint for an agent card via /.well-known/agent.json
   */
  async discoverEndpoint(endpoint: string, authToken?: string): Promise<DiscoveryResult> {
    const client = new A2AClient({ endpoint, authToken, timeoutMs: DISCOVERY_TIMEOUT_MS });
    const agentCard = await client.discover();
    const transport = this.detectTransport(agentCard);
    return { endpoint, agentCard, transport };
  }

  /**
   * Discover agents from Kubernetes service labels.
   * Only runs when KUBERNETES_SERVICE_HOST env var is set (in-cluster).
   * Queries K8s API for services with label multiqlti.io/agent=true.
   */
  async discoverFromKubernetes(namespace?: string): Promise<DiscoveryResult[]> {
    if (!process.env.KUBERNETES_SERVICE_HOST) return [];

    const ns = namespace ?? "default";
    const token = await this.readServiceAccountToken();
    const apiBase = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`;

    const url = `${apiBase}/api/v1/namespaces/${ns}/services?labelSelector=${encodeURIComponent("multiqlti.io/agent=true")}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return [];

    const data = (await res.json()) as K8sServiceList;

    const results: DiscoveryResult[] = [];
    for (const svc of data.items) {
      const port = svc.spec.ports.find((p) => p.name === "a2a" || p.name === "mcp")?.port ?? 8080;
      const svcEndpoint = `http://${svc.metadata.name}.${svc.metadata.namespace}.svc.cluster.local:${port}`;
      try {
        const result = await this.discoverEndpoint(svcEndpoint);
        results.push(result);
      } catch {
        // Skip unreachable services
      }
    }
    return results;
  }

  /**
   * Health check a remote agent -- probe its discovery endpoint.
   */
  async healthCheck(agent: RemoteAgentConfig): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const client = new A2AClient({
        endpoint: agent.endpoint,
        authToken: agent.authTokenEnc ?? undefined,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
      });
      const agentCard = await client.discover();
      return {
        status: "online",
        agentCard,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        status: "offline",
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Determine transport protocol from agent card capabilities.
   */
  private detectTransport(card: AgentCard): string {
    if (card.capabilities?.streaming) return "mcp-streamable-http";
    return "a2a-http";
  }

  /**
   * Read the in-cluster Kubernetes service account token.
   */
  private async readServiceAccountToken(): Promise<string> {
    const { readFile } = await import("fs/promises");
    return readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf-8");
  }
}
