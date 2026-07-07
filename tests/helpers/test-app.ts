/**
 * Test application factory.
 *
 * Builds a minimal Express app wired with MemStorage + MockProvider.
 * No DB, no real LLM calls — fully in-memory.
 * A synthetic admin user is injected into every request so RBAC middleware
 * functions correctly without a real auth layer.
 */
import express from "express";
import { MemStorage } from "../../server/storage.js";
import { MockProvider } from "../../server/gateway/providers/mock.js";
import { registerModelRoutes } from "../../server/routes/models.js";
import { DEFAULT_MODELS } from "../../shared/constants.js";
import type { User } from "../../shared/types.js";

export interface TestApp {
  app: express.Express;
  storage: MemStorage;
  mockProvider: MockProvider;
  close: () => Promise<void>;
}

/** Synthetic admin user injected into every test request. */
const TEST_ADMIN_USER: User = {
  id: "test-user-id",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

export async function createTestApp(): Promise<TestApp> {
  const storage = new MemStorage();
  const mockProvider = new MockProvider();

  const app = express();
  app.use(express.json());

  // Inject synthetic admin user so RBAC middleware passes without real auth
  app.use((req, _res, next) => {
    req.user = TEST_ADMIN_USER;
    next();
  });

  // Register only the routes under test (no auth, no full-app dependencies)
  registerModelRoutes(app, storage);

  // Seed default models (all mock provider)
  for (const model of DEFAULT_MODELS) {
    await storage.createModel(model);
  }

  // Seed a named "mock" model slug for tests that reference it explicitly
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
