/**
 * Remote Agent Routes — Phase 8.9
 *
 * Endpoints:
 *   GET    /api/remote-agents              — list all registered agents
 *   POST   /api/remote-agents              — register a new agent
 *   GET    /api/remote-agents/status       — connection status for all agents
 *   GET    /api/remote-agents/:id          — get agent details
 *   PUT    /api/remote-agents/:id          — update agent config
 *   DELETE /api/remote-agents/:id          — remove agent
 *   POST   /api/remote-agents/:id/connect  — connect to agent
 *   POST   /api/remote-agents/:id/disconnect — disconnect
 *   GET    /api/remote-agents/:id/health   — trigger health check
 *   POST   /api/remote-agents/:id/dispatch — send A2A task
 *
 * All routes require authentication (covered by upstream requireAuth middleware).
 */
import type { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { remoteAgents } from "@shared/schema";
import type { RemoteAgentManager } from "../remote-agents/remote-agent-manager";

// ─── Validation schemas ───────────────────────────────────────────────────────

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  environment: z.enum(["kubernetes", "linux", "docker", "cloud"]),
  transport: z
    .enum(["mcp-sse", "mcp-streamable-http", "a2a-http", "a2a-grpc"])
    .default("a2a-http"),
  endpoint: z.string().url(),
  cluster: z.string().max(100).optional(),
  namespace: z.string().max(100).optional(),
  labels: z.record(z.string()).optional(),
  authTokenEnc: z.string().optional(),
  enabled: z.boolean().default(true),
  autoConnect: z.boolean().default(false),
});

const UpdateAgentSchema = CreateAgentSchema.partial();

const DispatchSchema = z.object({
  message: z.object({
    role: z.enum(["user", "agent"]),
    parts: z
      .array(
        z.object({
          type: z.enum(["text", "data", "file"]),
          text: z.string().optional(),
          data: z.record(z.unknown()).optional(),
        }),
      )
      .min(1),
  }),
  skill: z.string().optional(),
});

// ─── Route registration ───────────────────────────────────────────────────────

export function registerRemoteAgentRoutes(
  router: Router,
  manager: RemoteAgentManager | null,
): void {
  // Guard: if manager is unavailable, return 503 on all endpoints
  const requireManager = () => manager !== null;

  // ── GET /api/remote-agents ──────────────────────────────────────────────────

  router.get("/api/remote-agents", async (_req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    try {
      const agents = await manager!.listAgents();
      return res.json(agents);
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── POST /api/remote-agents ─────────────────────────────────────────────────

  router.post("/api/remote-agents", async (req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    const parse = CreateAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: parse.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    }
    try {
      const agent = await manager!.registerAgent(parse.data);
      return res.status(201).json(agent);
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/remote-agents/status ───────────────────────────────────────────
  // NOTE: Must be registered before /:id to avoid matching "status" as an id.

  router.get("/api/remote-agents/status", async (_req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    try {
      const agents = await manager!.listAgents();
      const statusMap: Record<
        string,
        { name: string; status: string; connected: boolean }
      > = {};
      for (const agent of agents) {
        statusMap[agent.id] = {
          name: agent.name,
          status: agent.status,
          connected: manager!.getConnectionStatus(agent.id),
        };
      }
      return res.json(statusMap);
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── GET /api/remote-agents/:id ──────────────────────────────────────────────

  router.get("/api/remote-agents/:id", async (req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    try {
      const agent = await manager!.getAgent(req.params.id);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      return res.json(agent);
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── PUT /api/remote-agents/:id ──────────────────────────────────────────────

  router.put("/api/remote-agents/:id", async (req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    const parse = UpdateAgentSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: parse.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    }
    try {
      const existing = await manager!.getAgent(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Agent not found" });
      }

      // Build the update set from validated fields
      const data = parse.data;
      const updateSet: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updateSet.name = data.name;
      if (data.environment !== undefined)
        updateSet.environment = data.environment;
      if (data.transport !== undefined) updateSet.transport = data.transport;
      if (data.endpoint !== undefined) updateSet.endpoint = data.endpoint;
      if (data.cluster !== undefined) updateSet.cluster = data.cluster;
      if (data.namespace !== undefined) updateSet.namespace = data.namespace;
      if (data.labels !== undefined) updateSet.labels = data.labels;
      if (data.authTokenEnc !== undefined)
        updateSet.authTokenEnc = data.authTokenEnc;
      if (data.enabled !== undefined) updateSet.enabled = data.enabled;
      if (data.autoConnect !== undefined)
        updateSet.autoConnect = data.autoConnect;

      await db
        .update(remoteAgents)
        .set(updateSet)
        .where(eq(remoteAgents.id, req.params.id));

      const updated = await manager!.getAgent(req.params.id);
      return res.json(updated);
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── DELETE /api/remote-agents/:id ───────────────────────────────────────────

  router.delete("/api/remote-agents/:id", async (req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    try {
      await manager!.unregisterAgent(req.params.id);
      return res.status(204).end();
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── POST /api/remote-agents/:id/connect ─────────────────────────────────────

  router.post("/api/remote-agents/:id/connect", async (req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    try {
      const agent = await manager!.getAgent(req.params.id);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      await manager!.connectAgent(req.params.id);
      return res.json({ ok: true, agentId: req.params.id, status: "connected" });
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: (e as Error).message });
    }
  });

  // ── POST /api/remote-agents/:id/disconnect ──────────────────────────────────

  router.post("/api/remote-agents/:id/disconnect", async (req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    try {
      const agent = await manager!.getAgent(req.params.id);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      await manager!.disconnectAgent(req.params.id);
      return res.json({
        ok: true,
        agentId: req.params.id,
        status: "disconnected",
      });
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: (e as Error).message });
    }
  });

  // ── GET /api/remote-agents/:id/health ───────────────────────────────────────

  router.get("/api/remote-agents/:id/health", async (req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    try {
      const agent = await manager!.getAgent(req.params.id);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      // Re-read after connect attempt to get fresh status
      // connectAgent performs health check internally
      try {
        await manager!.connectAgent(req.params.id);
      } catch {
        // health check may fail — that is fine, status is updated in DB
      }
      const refreshed = await manager!.getAgent(req.params.id);
      return res.json({
        agentId: req.params.id,
        status: refreshed?.status ?? "offline",
        lastHeartbeatAt: refreshed?.lastHeartbeatAt ?? null,
        healthError: refreshed?.healthError ?? null,
      });
    } catch (e) {
      return res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── POST /api/remote-agents/:id/dispatch ────────────────────────────────────

  router.post("/api/remote-agents/:id/dispatch", async (req, res) => {
    if (!requireManager()) {
      return res
        .status(503)
        .json({ error: "Remote agent subsystem is not available" });
    }
    const parse = DispatchSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "Validation failed",
        issues: parse.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    }
    try {
      const agent = await manager!.getAgent(req.params.id);
      if (!agent) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const result = await manager!.dispatchTask(
        req.params.id,
        parse.data.message,
        { skill: parse.data.skill },
      );
      return res.json(result);
    } catch (e) {
      return res
        .status(500)
        .json({ error: (e as Error).message });
    }
  });
}
