import { eq } from "drizzle-orm";
import { db, withProject, withProjectInsert } from "../db";
import { runAsSystem, unscopedSystemQuery } from "../context";
import { remoteAgents, a2aTasks } from "@shared/schema";
import { encrypt, decrypt } from "../crypto";
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
    // Wrap the entire init (getAllAgents + auto-connect loop) in runAsSystem so
    // that getAllAgents' unscopedSystemQuery assertion passes, and all subsequent
    // manager calls (getAgent, connectAgent) run in system context where
    // withProject strips the project filter and returns the id-only condition.
    await runAsSystem("remote-agent-manager-init", async () => {
      const agents = await this.getAllAgents();
      for (const agent of agents) {
        if (agent.autoConnect && agent.enabled) {
          await this.connectAgent(agent.id).catch(() => {
            // Agent may be unreachable at startup -- continue with others
          });
        }
      }
    });
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

    // H-5: withProjectInsert stamps projectId from the current ALS context
    // (the POST route runs under requireProject, so context is always present).
    const [created] = await db
      .insert(remoteAgents)
      .values(
        withProjectInsert(remoteAgents, {
          name: input.name,
          environment: input.environment,
          transport: input.transport,
          endpoint: input.endpoint,
          cluster: input.cluster ?? null,
          namespace: input.namespace ?? null,
          labels: input.labels ?? null,
          // Encrypt the bearer token before persisting (PR-0d: encrypt plaintext authTokenEnc).
          authTokenEnc: input.authTokenEnc ? encrypt(input.authTokenEnc) : null,
          enabled: input.enabled ?? true,
          autoConnect: input.autoConnect ?? false,
          status: agentCard ? "online" : "offline",
          agentCard: agentCard as unknown as Record<string, unknown> | null,
        }),
      )
      .returning();

    return this.rowToConfig(created);
  }

  async unregisterAgent(agentId: string): Promise<void> {
    this.clients.delete(agentId);
    // H-4: scope the DELETE to the current project so project A cannot delete
    // project B's agent by guessing an ID.
    await db
      .delete(remoteAgents)
      .where(withProject(remoteAgents, eq(remoteAgents.id, agentId)));
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

    // H-4: scope the UPDATE so this cannot modify a cross-project agent.
    // In system context (startup/heartbeat) withProject strips the project filter
    // and applies only the id condition — correct for system-level operations.
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
      .where(withProject(remoteAgents, eq(remoteAgents.id, agentId)));
  }

  async disconnectAgent(agentId: string): Promise<void> {
    this.clients.delete(agentId);
    // H-4: scope the UPDATE to the current project.
    await db
      .update(remoteAgents)
      .set({ status: "offline" as const, updatedAt: new Date() })
      .where(withProject(remoteAgents, eq(remoteAgents.id, agentId)));
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

    // H-6: withProjectInsert stamps projectId on the task row from ALS context
    // (dispatch routes run under requireProject).
    const [task] = await db
      .insert(a2aTasks)
      .values(
        withProjectInsert(a2aTasks, {
          agentId,
          runId: options?.runId ?? null,
          stageExecutionId: options?.stageExecutionId ?? null,
          skill: options?.skill ?? null,
          input: message as unknown as Record<string, unknown>,
          status: "submitted",
        }),
      )
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

  /**
   * List agents scoped to the current project (per-project HTTP routes).
   *
   * MUST be called in a per-project request context (requireProject sets it).
   * withProject(remoteAgents) injects WHERE projectId = ? from the ALS context.
   * In system context this would throw (no bare withProject without condition) —
   * use getAllAgents() instead for background/heartbeat callers.
   */
  async listAgents(): Promise<RemoteAgentConfig[]> {
    const rows = await db
      .select()
      .from(remoteAgents)
      .where(withProject(remoteAgents))
      .orderBy(remoteAgents.name);
    return rows.map((r) => this.rowToConfig(r));
  }

  /**
   * List ALL agents across all projects — for system/background callers only.
   *
   * MUST be called inside runAsSystem(reason, fn) — unscopedSystemQuery enforces
   * this structurally. Mirrors the getAllEnabledTriggersByType pattern.
   */
  private async getAllAgents(): Promise<RemoteAgentConfig[]> {
    const rows = await unscopedSystemQuery("agent-heartbeat-list", () =>
      db.select().from(remoteAgents).orderBy(remoteAgents.name),
    );
    return rows.map((r) => this.rowToConfig(r));
  }

  /**
   * Get a single agent by ID, scoped to the current project.
   *
   * H-4: withProject adds AND projectId = ? so cross-project ID guessing
   * returns null (→ 404 in routes) instead of leaking another project's config.
   * In system context withProject strips the project filter, returning only
   * the id condition — correct for startup/heartbeat callers.
   */
  async getAgent(agentId: string): Promise<RemoteAgentConfig | null> {
    const [row] = await db
      .select()
      .from(remoteAgents)
      .where(withProject(remoteAgents, eq(remoteAgents.id, agentId)));
    return row ? this.rowToConfig(row) : null;
  }

  getConnectionStatus(agentId: string): boolean {
    return this.clients.has(agentId);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatInterval = setInterval(async () => {
      // Wrap the entire heartbeat body in runAsSystem so that getAllAgents()
      // (which asserts system context via unscopedSystemQuery) and any DB
      // writes all execute under the same audit-trail context.
      await runAsSystem("remote-agent-heartbeat", async () => {
        const agents = await this.getAllAgents();
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
      });
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
      // Decrypt at the DB boundary so internal callers (connectAgent) receive the
      // plaintext token. HTTP responses MUST strip this via toPublicAgent() in the
      // route layer (H-3 fix in routes/remote-agents.ts).
      authTokenEnc: row.authTokenEnc ? decrypt(row.authTokenEnc) : null,
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
