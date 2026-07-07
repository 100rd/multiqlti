/**
 * Full test application factory for integration tests that need routes beyond
 * the core model set (privacy, sandbox, settings).
 *
 * Includes:
 * - All routes from test-app.ts (models)
 * - Privacy routes
 * - Sandbox routes (reports available:false when Docker is absent)
 * - Settings routes (DB-less mode — returns HTML-safe JSON only)
 *
 * Auth: injects synthetic admin user on all requests (DISABLE_AUTH pattern).
 */
import express from "express";
import { MemStorage } from "../../server/storage.js";
import { MockProvider } from "../../server/gateway/providers/mock.js";
import { registerModelRoutes } from "../../server/routes/models.js";
import { registerPrivacyRoutes } from "../../server/routes/privacy.js";
import { registerSandboxRoutes } from "../../server/routes/sandbox.js";
import { DEFAULT_MODELS } from "../../shared/constants.js";
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

  const app = express();
  app.use(express.json());

  // Inject synthetic admin user so all RBAC checks pass
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN_USER;
    next();
  });

  // Core routes
  registerModelRoutes(app, storage);

  // Extended routes under test
  registerPrivacyRoutes(app as unknown as Router);
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

  return {
    app,
    storage,
    mockProvider,
    close: () => Promise.resolve(),
  };
}
