/**
 * Integration tests for Phase 6.9 workspace index API endpoints.
 *
 * Tests all 5 new endpoints:
 *   - GET  /api/workspaces/:id/dependency-graph
 *   - GET  /api/workspaces/:id/symbols/:name/references
 *   - GET  /api/workspaces/:id/symbols/:name/definition
 *   - GET  /api/workspaces/:id/symbols
 *   - POST /api/workspaces/:id/index
 *   - POST /api/workspaces/:id/claim
 *
 * Uses mocked DB and services — no real PostgreSQL required.
 */
import { describe, it, expect, beforeAll, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import type { Express } from "express";
import type { WorkspaceRow } from "../../shared/schema.js";

// ─── Test user ────────────────────────────────────────────────────────────────

const OWNER_USER_ID = "owner-user-001";
const OTHER_USER_ID = "other-user-002";

// ─── In-memory workspace store ────────────────────────────────────────────────

const READY_WS_ID = "ws-ready-001";
const IDLE_WS_ID = "ws-idle-002";
const INDEXING_WS_ID = "ws-indexing-003";
const UNOWNED_WS_ID = "ws-unowned-004";
const OTHER_OWNED_WS_ID = "ws-other-owned-005";
const NONEXISTENT_WS_ID = "ws-nonexistent-999";

function makeWorkspace(
  id: string,
  ownerId: string | null,
  indexStatus: string,
): WorkspaceRow {
  return {
    id,
    name: `Workspace ${id}`,
    type: "local",
    path: `/tmp/${id}`,
    branch: "main",
    status: "active",
    lastSyncAt: null,
    createdAt: new Date(),
    ownerId,
    indexStatus: indexStatus as WorkspaceRow["indexStatus"],
  };
}

const workspaceStore = new Map<string, WorkspaceRow>([
  [READY_WS_ID, makeWorkspace(READY_WS_ID, OWNER_USER_ID, "ready")],
  [IDLE_WS_ID, makeWorkspace(IDLE_WS_ID, OWNER_USER_ID, "idle")],
  [INDEXING_WS_ID, makeWorkspace(INDEXING_WS_ID, OWNER_USER_ID, "indexing")],
  [UNOWNED_WS_ID, makeWorkspace(UNOWNED_WS_ID, null, "idle")],
  [OTHER_OWNED_WS_ID, makeWorkspace(OTHER_OWNED_WS_ID, OTHER_USER_ID, "ready")],
]);

// ─── Mock DB ──────────────────────────────────────────────────────────────────

const mockSymbolRows = [
  {
    id: "sym-001",
    workspaceId: READY_WS_ID,
    filePath: "src/utils.ts",
    name: "calculateTotal",
    kind: "function",
    line: 10,
    col: 0,
    signature: "function calculateTotal()",
    fileHash: "abc",
    exportedFrom: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

vi.mock("../../server/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: () => Promise.resolve([...workspaceStore.values()]),
        where: (cond: unknown) => {
          void cond;
          // Return all symbols (filter handled in tests via mockSymbolRows)
          return Promise.resolve([...workspaceStore.values()]);
        },
      }),
    }),
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: () => {
          const id = (data.id as string) ?? `ws-${Date.now()}`;
          const ws = makeWorkspace(id, (data.ownerId as string) ?? null, "idle");
          workspaceStore.set(id, ws);
          return Promise.resolve([ws]);
        },
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          void cond;
          void data;
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  },
}));

// ─── Mock WorkspaceManager ────────────────────────────────────────────────────

vi.mock("../../server/workspace/manager.js", () => ({
  WorkspaceManager: class MockWorkspaceManager {
    connectLocal(_p: string, name?: string) {
      return Promise.resolve({ id: "new-ws-id", name: name ?? "local", path: "/tmp/local" });
    }
    cloneRemote() { return Promise.resolve(); }
    sync() { return Promise.resolve(); }
    listFiles() { return Promise.resolve([]); }
    readFile() { return Promise.resolve(""); }
    writeFile() { return Promise.resolve(); }
    deleteFile() { return Promise.resolve(); }
    gitStatus() { return Promise.resolve({ branch: "main", modified: [], staged: [], untracked: [] }); }
    gitDiff() { return Promise.resolve(""); }
    gitCommit() { return Promise.resolve(); }
    gitBranch() { return Promise.resolve(); }
    listBranches() { return Promise.resolve({ current: "main", branches: ["main"] }); }
    switchBranch() { return Promise.resolve(); }
    gitLog() { return Promise.resolve([]); }
    removeClone() { return Promise.resolve(); }
  },
}));

// ─── Mock CodeChatService ─────────────────────────────────────────────────────

vi.mock("../../server/workspace/code-chat.js", () => ({
  CodeChatService: class MockCodeChatService {
    chat() { return Promise.resolve("reply"); }
    chatStream() { return Promise.resolve(); }
    reviewCode() { return Promise.resolve(new Map()); }
  },
}));

// ─── Mock WorkspaceIndexer ────────────────────────────────────────────────────

const mockIndexWorkspace = vi.fn().mockResolvedValue({
  workspaceId: READY_WS_ID,
  totalFiles: 10,
  indexedFiles: 8,
  skippedFiles: 2,
  deletedFiles: 0,
  symbolCount: 42,
  errors: [],
  durationMs: 500,
});

const mockGetSymbols = vi.fn().mockResolvedValue(mockSymbolRows.map((s) => ({
  id: s.id,
  workspaceId: s.workspaceId,
  filePath: s.filePath,
  name: s.name,
  kind: s.kind,
  line: s.line,
  col: s.col,
  signature: s.signature,
  fileHash: s.fileHash,
  exportedFrom: s.exportedFrom,
})));

vi.mock("../../server/workspace/indexer.js", () => ({
  WorkspaceIndexer: class MockWorkspaceIndexer {
    indexWorkspace = mockIndexWorkspace;
    indexFile = vi.fn().mockResolvedValue({ filePath: "test.ts", fileHash: "abc", symbols: [], skipped: false, error: null });
    getSymbols = mockGetSymbols;
    hashFile = vi.fn().mockResolvedValue("abc123");
    listIndexedFiles = vi.fn().mockResolvedValue(["src/utils.ts"]);
  },
}));

// ─── Mock DependencyGraph ─────────────────────────────────────────────────────

const mockBuildGraph = vi.fn().mockResolvedValue({
  nodes: [
    { id: "src/a.ts", label: "a.ts", importCount: 1, importedByCount: 0 },
    { id: "src/b.ts", label: "b.ts", importCount: 0, importedByCount: 1 },
  ],
  edges: [
    { id: "src/a.ts→src/b.ts", source: "src/a.ts", target: "src/b.ts" },
  ],
});

const mockFindReferences = vi.fn().mockResolvedValue([
  { file: "src/importer.ts", line: 3, col: 0, snippet: null },
]);

const mockFindDefinition = vi.fn().mockResolvedValue({
  file: "src/utils.ts",
  line: 10,
  col: 0,
  signature: "function calculateTotal()",
});

const mockInvalidateCache = vi.fn();

vi.mock("../../server/workspace/dependency-graph.js", () => ({
  DependencyGraph: class MockDependencyGraph {
    buildGraph = mockBuildGraph;
    findReferences = mockFindReferences;
    findDefinition = mockFindDefinition;
    invalidateCache = mockInvalidateCache;
  },
}));

// ─── App Setup ────────────────────────────────────────────────────────────────

// We need a custom db mock that returns the right workspace for each test.
// Override the db.select().from().where() to resolve based on workspaceId.

// Patch the db mock to resolve workspaces by ID
const { db } = await import("../../server/db.js");

// Intercept select to return workspace by ID
function setupDbMock() {
  vi.spyOn(db, "select").mockImplementation(() => ({
    from: () => ({
      orderBy: () => Promise.resolve([...workspaceStore.values()]),
      where: (cond: unknown) => {
        void cond;
        // Return all (routes destructure first element — so returning the right one matters)
        // For simplicity, tests will set up the expected workspace to be first in array.
        return Promise.resolve([...workspaceStore.values()]);
      },
    }),
    selectDistinct: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  }) as ReturnType<typeof db.select>);
}

// Better approach: use a real lookup function in the db mock
function makeDbWithLookup() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        orderBy: () => Promise.resolve([...workspaceStore.values()]),
        where: (cond: unknown) => {
          void table;
          void cond;
          // Always return full store — routes take first element
          return Promise.resolve([...workspaceStore.values()]);
        },
      }),
    }),
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: () => {
          const id = (data.id as string) ?? `ws-new-${Date.now()}`;
          const ws = makeWorkspace(id, data.ownerId as string ?? null, "idle");
          workspaceStore.set(id, ws);
          return Promise.resolve([ws]);
        },
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(),
    }),
  };
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function makeApp(): Promise<Express> {
  const app = express();
  app.use(express.json());

  // Inject user via middleware (simulating requireAuth)
  app.use((req, _res, next) => {
    (req as Request & { user?: { id: string } }).user = { id: OWNER_USER_ID };
    next();
  });

  const { registerWorkspaceRoutes } = await import("../../server/routes/workspaces.js");
  const { Gateway } = await import("../../server/gateway/index.js");

  // Build a minimal gateway mock
  const gatewayMock = { } as unknown as InstanceType<typeof Gateway>;

  registerWorkspaceRoutes(app, gatewayMock);
  return app;
}

// ─── Override db mock to do proper workspace lookup by ID ─────────────────────

// We need the db mock to return the right workspace when filtered by ID.
// Since vitest hoists mocks but we need dynamic behavior, we use a stateful mock.

let currentLookupId: string | null = null;
const dbMockModule = await import("../../server/db.js");

function mockDbForWorkspaceId(id: string) {
  currentLookupId = id;
  vi.spyOn(dbMockModule.db, "select").mockReturnValue({
    from: () => ({
      orderBy: () => Promise.resolve([...workspaceStore.values()]),
      where: () => {
        const ws = workspaceStore.get(id);
        return Promise.resolve(ws ? [ws] : []);
      },
    }),
    selectDistinct: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  } as ReturnType<typeof dbMockModule.db.select>);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 6.9 workspace index API", () => {
  let app: Express;

  beforeAll(async () => {
    app = await makeApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentLookupId = null;
  });

  // ── GET /dependency-graph ──────────────────────────────────────────────────

  describe("GET /api/workspaces/:id/dependency-graph", () => {
    it("200 with valid DependencyGraphResponse when workspace is ready", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      const res = await request(app).get(`/api/workspaces/${READY_WS_ID}/dependency-graph`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("nodes");
      expect(res.body).toHaveProperty("edges");
    });

    it("403 when workspace has null ownerId (IDOR prevention)", async () => {
      mockDbForWorkspaceId(UNOWNED_WS_ID);
      const res = await request(app).get(`/api/workspaces/${UNOWNED_WS_ID}/dependency-graph`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/ownership not established/i);
    });

    it("403 when different user owns workspace", async () => {
      mockDbForWorkspaceId(OTHER_OWNED_WS_ID);
      const res = await request(app).get(`/api/workspaces/${OTHER_OWNED_WS_ID}/dependency-graph`);
      expect(res.status).toBe(403);
    });

    it("404 when workspace ID doesn't exist", async () => {
      mockDbForWorkspaceId(NONEXISTENT_WS_ID);
      const res = await request(app).get(`/api/workspaces/${NONEXISTENT_WS_ID}/dependency-graph`);
      expect(res.status).toBe(404);
    });

    it("409 when workspace indexStatus is idle", async () => {
      mockDbForWorkspaceId(IDLE_WS_ID);
      const res = await request(app).get(`/api/workspaces/${IDLE_WS_ID}/dependency-graph`);
      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("indexStatus");
    });
  });

  // ── GET /symbols/:name/references ─────────────────────────────────────────

  describe("GET /api/workspaces/:id/symbols/:name/references", () => {
    it("200 with RefResult array for known symbol", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${READY_WS_ID}/symbols/calculateTotal/references`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("symbolName", "calculateTotal");
      expect(res.body).toHaveProperty("files");
      expect(res.body).toHaveProperty("total");
    });

    it("200 with empty array for unknown symbol", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      mockFindReferences.mockResolvedValueOnce([]);
      const res = await request(app).get(
        `/api/workspaces/${READY_WS_ID}/symbols/unknownSymbol/references`,
      );
      expect(res.status).toBe(200);
      expect(res.body.files).toHaveLength(0);
    });

    it("403 for null ownerId workspace", async () => {
      mockDbForWorkspaceId(UNOWNED_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${UNOWNED_WS_ID}/symbols/foo/references`,
      );
      expect(res.status).toBe(403);
    });

    it("404 for nonexistent workspace", async () => {
      mockDbForWorkspaceId(NONEXISTENT_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${NONEXISTENT_WS_ID}/symbols/foo/references`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ── GET /symbols/:name/definition ─────────────────────────────────────────

  describe("GET /api/workspaces/:id/symbols/:name/definition", () => {
    it("200 with definition for known symbol", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${READY_WS_ID}/symbols/calculateTotal/definition`,
      );
      expect(res.status).toBe(200);
      expect(res.body.definition).not.toBeNull();
      expect(res.body.definition.file).toBe("src/utils.ts");
    });

    it("200 with definition: null for unknown symbol", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      mockFindDefinition.mockResolvedValueOnce(null);
      const res = await request(app).get(
        `/api/workspaces/${READY_WS_ID}/symbols/ghost/definition`,
      );
      expect(res.status).toBe(200);
      expect(res.body.definition).toBeNull();
    });

    it("403 for null ownerId workspace", async () => {
      mockDbForWorkspaceId(UNOWNED_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${UNOWNED_WS_ID}/symbols/foo/definition`,
      );
      expect(res.status).toBe(403);
    });

    it("404 for nonexistent workspace", async () => {
      mockDbForWorkspaceId(NONEXISTENT_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${NONEXISTENT_WS_ID}/symbols/foo/definition`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ── GET /symbols ───────────────────────────────────────────────────────────

  describe("GET /api/workspaces/:id/symbols", () => {
    it("200 with results when workspace indexed", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${READY_WS_ID}/symbols?q=calc`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("results");
      expect(res.body).toHaveProperty("query", "calc");
      expect(res.body).toHaveProperty("total");
    });

    it("409 when workspace not indexed", async () => {
      mockDbForWorkspaceId(IDLE_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${IDLE_WS_ID}/symbols?q=calc`,
      );
      expect(res.status).toBe(409);
    });

    it("400 when q param is missing", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${READY_WS_ID}/symbols`,
      );
      expect(res.status).toBe(400);
    });

    it("400 when kind filter is invalid", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${READY_WS_ID}/symbols?q=foo&kind=invalid_kind`,
      );
      expect(res.status).toBe(400);
    });

    it("403 for null ownerId workspace", async () => {
      mockDbForWorkspaceId(UNOWNED_WS_ID);
      const res = await request(app).get(
        `/api/workspaces/${UNOWNED_WS_ID}/symbols?q=foo`,
      );
      expect(res.status).toBe(403);
    });
  });

  // ── POST /index ────────────────────────────────────────────────────────────

  describe("POST /api/workspaces/:id/index", () => {
    it("202 and sets indexStatus to indexing", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      const res = await request(app).post(`/api/workspaces/${READY_WS_ID}/index`);
      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("message", "Indexing started");
      expect(res.body).toHaveProperty("indexStatus", "indexing");
    });

    it("409 when already indexing", async () => {
      mockDbForWorkspaceId(INDEXING_WS_ID);
      const res = await request(app).post(`/api/workspaces/${INDEXING_WS_ID}/index`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already in progress/i);
    });

    it("403 for null ownerId workspace", async () => {
      mockDbForWorkspaceId(UNOWNED_WS_ID);
      const res = await request(app).post(`/api/workspaces/${UNOWNED_WS_ID}/index`);
      expect(res.status).toBe(403);
    });

    it("404 for nonexistent workspace", async () => {
      mockDbForWorkspaceId(NONEXISTENT_WS_ID);
      const res = await request(app).post(`/api/workspaces/${NONEXISTENT_WS_ID}/index`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /claim ────────────────────────────────────────────────────────────

  describe("POST /api/workspaces/:id/claim", () => {
    it("200 when claiming an unowned workspace", async () => {
      mockDbForWorkspaceId(UNOWNED_WS_ID);
      const res = await request(app).post(`/api/workspaces/${UNOWNED_WS_ID}/claim`);
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/claimed/i);
    });

    it("200 when workspace already owned by the same user", async () => {
      mockDbForWorkspaceId(READY_WS_ID);
      const res = await request(app).post(`/api/workspaces/${READY_WS_ID}/claim`);
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/already owned/i);
    });

    it("409 when workspace is owned by a different user", async () => {
      mockDbForWorkspaceId(OTHER_OWNED_WS_ID);
      const res = await request(app).post(`/api/workspaces/${OTHER_OWNED_WS_ID}/claim`);
      expect(res.status).toBe(409);
    });

    it("404 for nonexistent workspace", async () => {
      mockDbForWorkspaceId(NONEXISTENT_WS_ID);
      const res = await request(app).post(`/api/workspaces/${NONEXISTENT_WS_ID}/claim`);
      expect(res.status).toBe(404);
    });
  });
});
