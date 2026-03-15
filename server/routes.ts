import type { Express, Router } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { Gateway } from "./gateway/index";
import { TeamRegistry } from "./teams/registry";
import { PipelineController } from "./controller/pipeline-controller";
import { WsManager } from "./ws/manager";
import { registerModelRoutes } from "./routes/models";
import { registerPipelineRoutes } from "./routes/pipelines";
import { registerRunRoutes } from "./routes/runs";
import { registerChatRoutes } from "./routes/chat";
import { registerGatewayRoutes } from "./routes/gateway";
import { registerStrategyRoutes } from "./routes/strategies";
import { registerPrivacyRoutes } from "./routes/privacy";
import { registerStatsRoutes } from "./routes/stats";
import { registerMemoryRoutes } from "./routes/memory";
import { registerToolRoutes } from "./routes/tools";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerAuthRoutes } from "./routes/auth";
import { registerSandboxRoutes } from "./routes/sandbox";
import { registerSettingsRoutes } from "./routes/settings";
import { registerMaintenanceRoutes } from "./routes/maintenance";
import { requireAuth } from "./auth/middleware";
import { DEFAULT_MODELS, DEFAULT_PIPELINE_STAGES } from "@shared/constants";
import { log } from "./index";

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // Initialize core systems
  const wsManager = new WsManager(httpServer);
  const gateway = new Gateway(storage);
  const teamRegistry = new TeamRegistry(gateway, wsManager);
  const controller = new PipelineController(storage, teamRegistry, wsManager, gateway);

  // Register auth routes first (public routes included)
  registerAuthRoutes(app);

  // Register protected route groups — all require authentication
  app.use("/api/pipelines", requireAuth);
  app.use("/api/runs", requireAuth);
  app.use("/api/models", requireAuth);
  app.use("/api/gateway", requireAuth);
  app.use("/api/settings", requireAuth);
  app.use("/api/workspaces", requireAuth);
  app.use("/api/chat", requireAuth);
  app.use("/api/questions", requireAuth);
  app.use("/api/stats", requireAuth);
  app.use("/api/strategies", requireAuth);
  app.use("/api/privacy", requireAuth);
  app.use("/api/memory", requireAuth);
  app.use("/api/memories", requireAuth);
  app.use("/api/tools", requireAuth);
  app.use("/api/providers", requireAuth);
  app.use("/api/teams", requireAuth);
  app.use("/api/sandbox", requireAuth);
  app.use("/api/maintenance", requireAuth);

  // Register route implementations
  registerModelRoutes(app, storage);
  registerPipelineRoutes(app, storage);
  registerRunRoutes(app, storage, controller);
  registerChatRoutes(app, storage, gateway, wsManager);
  registerGatewayRoutes(app, gateway);
  registerStrategyRoutes(app, storage);
  registerPrivacyRoutes(app);
  registerStatsRoutes(app, storage);
  registerMemoryRoutes(app, storage);
  registerToolRoutes(app, storage);
  registerWorkspaceRoutes(app, gateway);
  registerSandboxRoutes(app as unknown as Router);
  registerSettingsRoutes(app as unknown as Router, gateway);
  registerMaintenanceRoutes(app as unknown as Router);

  // Seed default models
  const existingModels = await storage.getModels();
  if (existingModels.length === 0) {
    for (const model of DEFAULT_MODELS) {
      await storage.createModel(model);
    }
    log(`Seeded ${DEFAULT_MODELS.length} default models`);
  }

  // Seed default pipeline template
  const existingPipelines = await storage.getPipelines();
  if (existingPipelines.length === 0) {
    await storage.createPipeline({
      name: "Full SDLC Pipeline",
      description:
        "Complete software development lifecycle: Planning → Architecture → Development → Testing → Code Review → Deployment → Monitoring",
      stages: DEFAULT_PIPELINE_STAGES,
      isTemplate: true,
    });
    log("Seeded default SDLC pipeline template");
  }

  // Global pending questions endpoint (protected by /api/questions middleware above)
  app.get("/api/questions/pending", async (_req, res) => {
    const pending = await storage.getPendingQuestions();
    res.json(pending);
  });

  // Stats summary endpoint (protected by /api/stats middleware above)
  app.get("/api/stats/summary", async (_req, res) => {
    const [allRuns, allPipelines, allModels] = await Promise.all([
      storage.getPipelineRuns(),
      storage.getPipelines(),
      storage.getModels(),
    ]);

    const totalRuns = allRuns.length;
    const activePipelines = allPipelines.filter((p) => !p.isTemplate).length;
    const modelsConfigured = allModels.filter((m) => m.isActive).length;

    const now = Date.now();
    const dayMs = 86_400_000;
    const runsLast7Days: number[] = Array.from({ length: 7 }, (_, offset) => {
      const dayStart = now - (6 - offset) * dayMs;
      const dayEnd = dayStart + dayMs;
      return allRuns.filter((r) => {
        const ts = r.startedAt ? new Date(r.startedAt).getTime() : 0;
        return ts >= dayStart && ts < dayEnd;
      }).length;
    });

    res.json({ totalRuns, activePipelines, modelsConfigured, runsLast7Days });
  });

  return httpServer;
}
