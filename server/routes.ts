import type { Express } from "express";
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
  const controller = new PipelineController(storage, teamRegistry, wsManager);

  // Register route groups
  registerModelRoutes(app, storage);
  registerPipelineRoutes(app, storage);
  registerRunRoutes(app, storage, controller);
  registerChatRoutes(app, storage, gateway, wsManager);
  registerGatewayRoutes(app, gateway);
  registerStrategyRoutes(app, storage);
  registerPrivacyRoutes(app);

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

  // Global pending questions endpoint
  app.get("/api/questions/pending", async (_req, res) => {
    const pending = await storage.getPendingQuestions();
    res.json(pending);
  });

  return httpServer;
}
