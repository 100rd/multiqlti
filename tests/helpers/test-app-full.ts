/**
 * Full test application factory for integration tests that need routes beyond
 * the core pipeline/model/run set (privacy, strategies, memory, sandbox, settings).
 *
 * Includes:
 * - All routes from test-app.ts (models, pipelines, runs)
 * - Privacy routes
 * - Strategy routes
 * - Memory routes
 * - Sandbox routes (reports available:false when Docker is absent)
 * - Settings routes (DB-less mode — returns HTML-safe JSON only)
 *
 * Auth: injects synthetic admin user on all requests (DISABLE_AUTH pattern).
 */
import express from "express";
import { createServer } from "http";
import { MemStorage } from "../../server/storage.js";
import { MockProvider } from "../../server/gateway/providers/mock.js";
import { Gateway } from "../../server/gateway/index.js";
import { TeamRegistry } from "../../server/teams/registry.js";
import { PipelineController } from "../../server/controller/pipeline-controller.js";
import { registerPipelineRoutes } from "../../server/routes/pipelines.js";
import { registerRunRoutes } from "../../server/routes/runs.js";
import { registerModelRoutes } from "../../server/routes/models.js";
import { registerPrivacyRoutes } from "../../server/routes/privacy.js";
import { registerStrategyRoutes } from "../../server/routes/strategies.js";
import { registerMemoryRoutes } from "../../server/routes/memory.js";
import { registerSandboxRoutes } from "../../server/routes/sandbox.js";
import { DEFAULT_MODELS, DEFAULT_PIPELINE_STAGES } from "../../shared/constants.js";
import type { User } from "../../shared/types.js";
import type { Router } from "express";

export interface FullTestApp {
  app: express.Express;
  storage: MemStorage;
  mockProvider: MockProvider;
  close: () => Promise<void>;
}

const TEST_ADMIN_USER: User = {
  id: "test-user-id",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

export async function createFullTestApp(): Promise<FullTestApp> {
  const storage = new MemStorage();
  const mockProvider = new MockProvider();
  const gateway = new Gateway(storage);
  const httpServer = createServer();
  const { WsManager } = await import("../../server/ws/manager.js");
  const wsManager = new WsManager(httpServer);
  const teamRegistry = new TeamRegistry(gateway, wsManager);
  const controller = new PipelineController(storage, teamRegistry, wsManager);

  const app = express();
  app.use(express.json());

  // Inject synthetic admin user so all RBAC checks pass
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN_USER;
    next();
  });

  // Core routes
  registerModelRoutes(app, storage);
  registerPipelineRoutes(app, storage);
  registerRunRoutes(app, storage, controller);

  // Extended routes under test
  registerPrivacyRoutes(app as unknown as Router);
  registerStrategyRoutes(app as unknown as Router, storage);
  registerMemoryRoutes(app as unknown as Router, storage);
  registerSandboxRoutes(app as unknown as Router);

  // Seed defaults
  for (const model of DEFAULT_MODELS) {
    await storage.createModel(model);
  }
  await storage.createModel({
    name: "Mock",
    slug: "mock",
    provider: "mock",
    contextLimit: 4096,
    isActive: true,
    capabilities: [],
  });
  await storage.createPipeline({
    name: "Full SDLC Pipeline",
    description: "Complete software development lifecycle",
    stages: DEFAULT_PIPELINE_STAGES,
    isTemplate: true,
  });

  return {
    app,
    storage,
    mockProvider,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}
