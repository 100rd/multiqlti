import { eq } from "drizzle-orm";
import { db } from "../db";
import { remoteAgents, a2aTasks } from "@shared/schema";
import { A2AClient } from "./a2a-client";
import { AgentDiscoveryService } from "./agent-discovery";
import type {
  RemoteAgentConfig,
  A2AMessage,
  AgentCard,
  RemoteAgentStatus,
} from "@shared/types";

// ─── Input / Output Types ───────────────────────────────────────────────────

export interface RemoteAgentCreateInput {
  name: string;
  environment: string;
  transport: string;
  endpoint: string;
  cluster?: string;
  namespace?: string;
  labels?: Record<string, string>;
  authTokenEnc?: string;
  enabled?: boolean;
  autoConnect?: boolean;
}

export interface AgentRouteConfig {
  agentId?: string;
  agentSelector?: Record<string, string>;
}

export interface TaskDispatchResult {
  taskId: string;
  status: string;
  output?: A2AMessage;
  error?: string;
  durationMs?: number;
}

// ─── Manager ────────────────────────────────────────────────────────────────

export class RemoteAgentManager {
  private clients = new Map<string, A2AClient>();
  private discovery = new AgentDiscoveryService();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Load all agents from DB and auto-connect those flagged for it. */
  async initialize(): Promise<void> {
    const agents = await this.listAgents();
    for (const agent of agents) {
      if (agent.autoConnect && agent.enabled) {
        await this.connectAgent(agent.id).catch(() => {
          // Agent may be unreachable at startup -- continue with others
        });
      }
    }
    this.startHeartbeat(60_000);
  }

  /** Stop the heartbeat loop and drop all client references. */
  async shutdown(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.clients.clear();
  }

  // ── Registration ───────────────────────────────────────────────────

  async registerAgent(input: RemoteAgentCreateInput): Promise<RemoteAgentConfig> {
    // Best-effort discovery to pre-populate agent card
    let agentCard: AgentCard | null = null;
    try {
      const result = await this.discovery.discoverEndpoint(
        input.endpoint,
        input.authTokenEnc,
      );
      agentCard = result.agentCard;
    } catch {
      // Agent may be offline -- register anyway with status offline
    }

    const [created] = await db
      .insert(remoteAgents)
      .values({
        name: input.name,
        environment: input.environment,
        transport: input.transport,
        endpoint: input.endpoint,
        cluster: input.cluster ?? null,
        namespace: input.namespace ?? null,
        labels: input.labels ?? null,
        authTokenEnc: input.authTokenEnc ?? null,
        enabled: input.enabled ?? true,
        autoConnect: input.autoConnect ?? false,
        status: agentCard ? "online" : "offline",
        agentCard: agentCard as unknown as Record<string, unknown> | null,
      })
      .returning();

    return this.rowToConfig(created);
  }

  async unregisterAgent(agentId: string): Promise<void> {
    this.clients.delete(agentId);
    await db.delete(remoteAgents).where(eq(remoteAgents.id, agentId));
  }

  // ── Connection ─────────────────────────────────────────────────────

  async connectAgent(agentId: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const client = new A2AClient({
      endpoint: agent.endpoint,
      authToken: agent.authTokenEnc ?? undefined,
      timeoutMs: 30_000,
    });

    // Verify connectivity via health check
    const health = await this.discovery.healthCheck(agent);

    this.clients.set(agentId, client);

    await db
      .update(remoteAgents)
      .set({
        status: health.status,
        lastHeartbeatAt: new Date(),
        healthError: health.error ?? null,
        agentCard:
          (health.agentCard as unknown as Record<string, unknown>) ?? null,
        updatedAt: new Date(),
      })
      .where(eq(remoteAgents.id, agentId));
  }

  async disconnectAgent(agentId: string): Promise<void> {
    this.clients.delete(agentId);
    await db
      .update(remoteAgents)
      .set({ status: "offline" as const, updatedAt: new Date() })
      .where(eq(remoteAgents.id, agentId));
  }

  // ── Routing ────────────────────────────────────────────────────────

  /**
   * Resolve a remote agent by explicit ID, label selector, or fall back
   * to the first online+enabled agent.
   */
  async resolveAgent(
    config: AgentRouteConfig,
  ): Promise<RemoteAgentConfig | null> {
    // 1. Explicit agent ID
    if (config.agentId) {
      return this.getAgent(config.agentId);
    }

    // 2. Label selector -- first online+enabled agent whose labels match
    if (config.agentSelector) {
      const all = await this.listAgents();
      return (
        all.find((a) => {
          if (a.status !== "online" || !a.enabled) return false;
          if (!a.labels) return false;
          return Object.entries(config.agentSelector!).every(
            ([k, v]) => a.labels?.[k] === v,
          );
        }) ?? null
      );
    }

    // 3. Any online + enabled agent
    const all = await this.listAgents();
    return all.find((a) => a.status === "online" && a.enabled) ?? null;
  }

  // ── Dispatch ───────────────────────────────────────────────────────

  async dispatchTask(
    agentId: string,
    message: A2AMessage,
    options?: { skill?: string; runId?: string; stageExecutionId?: string },
  ): Promise<TaskDispatchResult> {
    const client = this.clients.get(agentId);
    if (!client) throw new Error(`Agent ${agentId} not connected`);

    // Persist task before sending
    const [task] = await db
      .insert(a2aTasks)
      .values({
        agentId,
        runId: options?.runId ?? null,
        stageExecutionId: options?.stageExecutionId ?? null,
        skill: options?.skill ?? null,
        input: message as unknown as Record<string, unknown>,
        status: "submitted",
      })
      .returning();

    const start = Date.now();
    try {
      const result = await client.sendTask({
        skill: options?.skill,
        message,
        taskId: task.id,
      });

      const durationMs = Date.now() - start;
      await db
        .update(a2aTasks)
        .set({
          status: result.status ?? "completed",
          output: (result.output as unknown as Record<string, unknown>) ?? null,
          durationMs,
          updatedAt: new Date(),
        })
        .where(eq(a2aTasks.id, task.id));

      return {
        taskId: task.id,
        status: result.status,
        output: result.output,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      await db
        .update(a2aTasks)
        .set({ status: "failed", error, durationMs, updatedAt: new Date() })
        .where(eq(a2aTasks.id, task.id));

      return { taskId: task.id, status: "failed", error, durationMs };
    }
  }

  // ── Query ──────────────────────────────────────────────────────────

  async listAgents(): Promise<RemoteAgentConfig[]> {
    const rows = await db
      .select()
      .from(remoteAgents)
      .orderBy(remoteAgents.name);
    return rows.map((r) => this.rowToConfig(r));
  }

  async getAgent(agentId: string): Promise<RemoteAgentConfig | null> {
    const [row] = await db
      .select()
      .from(remoteAgents)
      .where(eq(remoteAgents.id, agentId));
    return row ? this.rowToConfig(row) : null;
  }

  getConnectionStatus(agentId: string): boolean {
    return this.clients.has(agentId);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatInterval = setInterval(async () => {
      const agents = await this.listAgents();
      for (const agent of agents) {
        if (!agent.enabled) continue;
        const health = await this.discovery.healthCheck(agent);
        await db
          .update(remoteAgents)
          .set({
            status: health.status,
            lastHeartbeatAt: new Date(),
            healthError: health.error ?? null,
            updatedAt: new Date(),
          })
          .where(eq(remoteAgents.id, agent.id));
      }
    }, intervalMs);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private rowToConfig(
    row: typeof remoteAgents.$inferSelect,
  ): RemoteAgentConfig {
    return {
      id: row.id,
      name: row.name,
      environment: row.environment as RemoteAgentConfig["environment"],
      transport: row.transport as RemoteAgentConfig["transport"],
      endpoint: row.endpoint,
      cluster: row.cluster,
      namespace: row.namespace,
      labels: row.labels as Record<string, string> | null,
      authTokenEnc: row.authTokenEnc,
      enabled: row.enabled,
      autoConnect: row.autoConnect,
      status: row.status as RemoteAgentConfig["status"],
      lastHeartbeatAt: row.lastHeartbeatAt,
      healthError: row.healthError,
      agentCard: row.agentCard as unknown as RemoteAgentConfig["agentCard"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
