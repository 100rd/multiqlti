/**
 * Test app factory for the LEGACY knowledge routes (server/routes/knowledge.ts).
 *
 * Issue #358: those routes were behind requireAuth but did NOT verify the
 * `:id` workspace belongs to the caller (authenticated IDOR). This factory
 * builds an express app over MemStorage with an INJECTED in-memory knowledge
 * store + deterministic embedding factory, so the integration tests can
 * exercise the workspace-scoping auth gate (404 → null-owner deny → 403 →
 * owner/admin allowed) without Ollama or pgvector.
 *
 * The authenticated user is injected by role and may own the seeded workspace,
 * so the requireOwnerOrRole path is covered. An `x-test-unauth` header strips
 * the user to model an unauthenticated request (401 ordering).
 */
import express from "express";
import type { Router } from "express";
import { MemStorage } from "../../server/storage.js";
import {
  registerKnowledgeRoutes,
  type KnowledgeDeps,
  type KnowledgeStore,
} from "../../server/routes/knowledge.js";
import type { EmbeddingProviderConfig } from "../../server/memory/embeddings.js";
import type { ChunkSourceType } from "../../server/memory/chunker.js";
import type { User, UserRole } from "../../shared/types.js";

export interface LegacyKnowledgeTestAppOptions {
  role?: UserRole;
  userId?: string;
  /** When true, the injected user owns the seeded workspace. */
  ownsWorkspace?: boolean;
  /** Owner id for the seeded workspace. Overrides ownsWorkspace when provided. */
  workspaceOwnerId?: string | null;
  /** Strip the authenticated user (model an unauthenticated request → 401). */
  unauth?: boolean;
}

export interface LegacyKnowledgeTestApp {
  app: express.Express;
  storage: MemStorage;
  workspaceId: string;
  /** Records of every mock-store interaction (for cross-workspace isolation assertions). */
  calls: KnowledgeStoreCalls;
}

/** Observable record of every mock-store interaction. */
export interface KnowledgeStoreCalls {
  listSources: string[];
  search: string[];
  insertChunks: Array<Record<string, unknown>>;
  deleteBySource: Array<{ workspaceId: string; sourceType: string; sourceId: string }>;
  getEmbeddingConfig: string[];
  upsertEmbeddingConfig: string[];
  countChunks: string[];
}

const DEFAULT_OWNER = "someone-else";

function makeMockStore(calls: KnowledgeStoreCalls): KnowledgeStore {
  return {
    async listSources(workspaceId) {
      calls.listSources.push(workspaceId);
      return [];
    },
    async search(workspaceId) {
      calls.search.push(workspaceId);
      return [];
    },
    async insertChunks(rows) {
      calls.insertChunks.push(...rows);
      return rows.map((_, i) => ({ id: `chunk-${i}` }));
    },
    async deleteBySource(workspaceId, sourceType, sourceId) {
      calls.deleteBySource.push({ workspaceId, sourceType, sourceId });
      return 0;
    },
    async countChunks(workspaceId) {
      calls.countChunks.push(workspaceId);
      return 0;
    },
    async getEmbeddingConfig(workspaceId) {
      calls.getEmbeddingConfig.push(workspaceId);
      return null;
    },
    async upsertEmbeddingConfig(workspaceId, cfg) {
      calls.upsertEmbeddingConfig.push(workspaceId);
      return {
        id: "cfg-1",
        workspaceId,
        provider: cfg.provider,
        model: cfg.model,
        dimensions: cfg.dimensions,
        config: cfg.options ?? {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      } as never;
    },
  };
}

export async function createLegacyKnowledgeTestApp(
  opts: LegacyKnowledgeTestAppOptions = {},
): Promise<LegacyKnowledgeTestApp> {
  const role: UserRole = opts.role ?? "admin";
  const userId = opts.userId ?? "test-user-id";

  const storage = new MemStorage();

  const ownerId =
    opts.workspaceOwnerId !== undefined
      ? opts.workspaceOwnerId
      : opts.ownsWorkspace
        ? userId
        : DEFAULT_OWNER;

  const workspace = await storage.createWorkspace({
    name: "Legacy KB Workspace",
    type: "local",
    path: "/tmp/legacy-kb",
    branch: "main",
    status: "active",
    ownerId,
  });

  const user: User = {
    id: userId,
    email: "legacy-kb@example.com",
    name: "Legacy KB User",
    isActive: true,
    role,
    lastLoginAt: null,
    createdAt: new Date(0),
  };

  const calls: KnowledgeStoreCalls = {
    listSources: [],
    search: [],
    insertChunks: [],
    deleteBySource: [],
    getEmbeddingConfig: [],
    upsertEmbeddingConfig: [],
    countChunks: [],
  };

  const deps: KnowledgeDeps = {
    createStore: () => makeMockStore(calls),
    createEmbeddingProvider: (_config: EmbeddingProviderConfig) => ({
      name: "ollama",
      model: "mock-embed",
      dimensions: 4,
      embed: async (_text: string) => new Array(4).fill(0.1),
      embedBatch: async (texts: string[]) => texts.map(() => new Array(4).fill(0.1)),
    }),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!opts.unauth && req.headers["x-test-unauth"] !== "1") {
      req.user = user;
    }
    next();
  });

  registerKnowledgeRoutes(app as unknown as Router, storage, deps);

  return { app, storage, workspaceId: workspace.id, calls };
}

export type { ChunkSourceType };
