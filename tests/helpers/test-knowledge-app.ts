/**
 * Test app factory for the practice-card (Active Knowledge Base) routes.
 *
 * Builds an express app over MemStorage with a MOCK embedding client and an
 * in-memory vector store, so integration tests exercise the real routes (auth
 * gates, zod validation, adversarial gate, state machine, projection, search
 * hydration) without Ollama or pgvector. The authenticated user is injected by
 * role, and may be the workspace owner so requireOwnerOrRole paths are covered.
 */
import express from "express";
import type { Router } from "express";
import { MemStorage } from "../../server/storage.js";
import {
  registerPracticeCardRoutes,
  type PracticeCardDeps,
  type VectorClient,
} from "../../server/routes/practice-cards.js";
import { KnowledgeRefreshScheduler } from "../../server/knowledge/refresh-scheduler.js";
import type { ComplianceGraph } from "../../server/knowledge/compliance-mapper.js";
import type { User, UserRole } from "../../shared/types.js";

export interface KnowledgeTestAppOptions {
  role?: UserRole;
  userId?: string;
  /** When true, the injected user owns the seeded workspace. */
  ownsWorkspace?: boolean;
  /** Force the embedding client to throw (simulate provider outage → 503). */
  embedFails?: boolean;
  /** Inject a compliance graph (or null to simulate a disabled/malformed graph). */
  complianceGraph?: ComplianceGraph | null;
  /**
   * Simulate an authenticated session whose user has NO id (a malformed/legacy
   * token). The role still satisfies the RBAC gate, so this isolates the
   * ingest "bound trusted ingester required" guard.
   */
  noUserId?: boolean;
}

export interface KnowledgeTestApp {
  app: express.Express;
  storage: MemStorage;
  workspaceId: string;
  /** In-memory chunk store written by the mock vector client. */
  chunks: Array<Record<string, unknown>>;
  /** Programmable search results — returned verbatim by the mock vector search. */
  setSearchResults: (results: Array<{ sourceId: string; score: number }>) => void;
  /** The refresh scheduler bound to this app's storage (for direct assertions). */
  refreshScheduler: KnowledgeRefreshScheduler;
}

const MOCK_DIM = 4;

export async function createKnowledgeTestApp(
  opts: KnowledgeTestAppOptions = {},
): Promise<KnowledgeTestApp> {
  const role: UserRole = opts.role ?? "admin";
  const userId = opts.userId ?? "test-user-id";

  const storage = new MemStorage();

  // Seed a workspace; optionally owned by the injected user.
  const workspace = await storage.createWorkspace({
    name: "KB Test Workspace",
    type: "local",
    path: "/tmp/kb-test",
    branch: "main",
    status: "active",
    ownerId: opts.ownsWorkspace ? userId : "someone-else",
  });

  const user: User = {
    // When noUserId is set, the session carries no usable id (cast through to
    // model a malformed token); the route guard must reject before persisting.
    id: opts.noUserId ? (undefined as unknown as string) : userId,
    email: "kb@example.com",
    name: "KB User",
    isActive: true,
    role,
    lastLoginAt: null,
    createdAt: new Date(0),
  };

  const chunks: Array<Record<string, unknown>> = [];
  let searchResults: Array<{ sourceId: string; score: number }> = [];

  const vector: VectorClient = {
    insertChunks: async (rows) => {
      chunks.push(...rows);
      return rows.map((_, i) => ({ id: `chunk-${chunks.length - rows.length + i}` }));
    },
    deleteBySource: async (workspaceId, sourceType, sourceId) => {
      const before = chunks.length;
      for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (c.workspaceId === workspaceId && c.sourceType === sourceType && c.sourceId === sourceId) {
          chunks.splice(i, 1);
        }
      }
      return before - chunks.length;
    },
    search: async () => searchResults,
  };

  // Use a non-cron schedule so start() is never needed in tests; triggerNow/execute work regardless.
  const refreshScheduler = new KnowledgeRefreshScheduler(storage, "0 6 * * 1");

  const deps: PracticeCardDeps = {
    getEmbeddingClient: async () => {
      if (opts.embedFails) throw new Error("embedding provider down");
      return {
        embed: async (_text: string) => new Array(MOCK_DIM).fill(0.1),
        dimensions: MOCK_DIM,
        model: "mock-embed",
        provider: "mock",
      };
    },
    vector,
    refresh: { triggerNow: (workspaceId, trigger) => refreshScheduler.triggerNow(workspaceId, trigger) },
    loadComplianceGraph: async () =>
      opts.complianceGraph === undefined ? null : opts.complianceGraph,
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });

  registerPracticeCardRoutes(app as unknown as Router, storage, deps);

  return {
    app,
    storage,
    workspaceId: workspace.id,
    chunks,
    setSearchResults: (results) => {
      searchResults = results;
    },
    refreshScheduler,
  };
}
