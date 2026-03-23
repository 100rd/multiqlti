import { A2AClient } from "./a2a-client-lite.js";
import type { AgentCardLite, A2ATaskResponse } from "./a2a-client-lite.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PeerAgent {
  name: string;
  endpoint: string;
  type: string;
  client: A2AClient;
}

export interface PeerInfo {
  name: string;
  type: string;
  endpoint: string;
}

// ─── Well-known agent types and their default ports ─────────────────────────

const AGENT_TYPES = ["k8s", "helm", "observability", "triage", "release"] as const;

const DEFAULT_PORTS: Record<string, number> = {
  k8s: 8080,
  helm: 8081,
  observability: 8082,
  release: 8083,
  triage: 8084,
};

// ─── Service ────────────────────────────────────────────────────────────────

/**
 * Discovers sibling agents within the same ABOX cluster via K8s service DNS.
 *
 * Opt-in: only active when ENABLE_PEER_DISCOVERY=true.
 * Looks for well-known agent service names in the configured namespace.
 */
export class PeerDiscovery {
  private peers = new Map<string, PeerAgent>();
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly selfName: string,
    private readonly namespace: string = process.env.AGENT_NAMESPACE ?? "default",
    private readonly authToken?: string,
  ) {}

  /**
   * Discover sibling agents via K8s service DNS.
   * Probes each well-known agent service name (except self) and records
   * those that respond with a valid agent card.
   */
  async discoverPeers(): Promise<PeerAgent[]> {
    for (const type of AGENT_TYPES) {
      if (type === this.getAgentType()) continue; // skip self

      const serviceName = `abox-agents-${type}`;
      const port = DEFAULT_PORTS[type] ?? 8080;
      const endpoint = `http://${serviceName}.${this.namespace}.svc.cluster.local:${port}`;

      try {
        const client = new A2AClient({ endpoint, authToken: this.authToken, timeoutMs: 5000 });
        const card: AgentCardLite = await client.discover();
        this.peers.set(type, { name: card.name, endpoint, type, client });
      } catch {
        // Peer not available -- remove stale entry if present
        this.peers.delete(type);
      }
    }

    return Array.from(this.peers.values());
  }

  /** Get a connected peer by agent type. */
  getPeer(agentType: string): PeerAgent | undefined {
    return this.peers.get(agentType);
  }

  /**
   * Call a peer agent's tool/skill.
   * Sends an A2A message/send request and extracts text output.
   */
  async callPeer(agentType: string, input: string, skill?: string): Promise<string> {
    const peer = this.peers.get(agentType);
    if (!peer) throw new Error(`Peer agent '${agentType}' not found or not connected`);

    const result: A2ATaskResponse = await peer.client.sendTask({
      message: { role: "user", parts: [{ type: "text", text: input }] },
      skill,
    });

    if (result.output?.parts) {
      return result.output.parts
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
    }
    return result.error ?? "No output from peer agent";
  }

  /** Start periodic peer refresh. */
  startRefresh(intervalMs = 60_000): void {
    this.refreshInterval = setInterval(() => {
      this.discoverPeers().catch(() => {});
    }, intervalMs);
  }

  /** Stop refresh and clear peers. */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.peers.clear();
  }

  /** List currently known peers. */
  listPeers(): PeerInfo[] {
    return Array.from(this.peers.values()).map((p) => ({
      name: p.name,
      type: p.type,
      endpoint: p.endpoint,
    }));
  }

  /** Derive the agent type from selfName (e.g. "k8s-agent" -> "k8s"). */
  private getAgentType(): string {
    return this.selfName.replace(/-agent$/, "");
  }
}
