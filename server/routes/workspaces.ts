/**
 * Workspace Routes
 *
 * Bug #128: Refactored to use IStorage for workspace CRUD instead of direct
 * db access, so MemStorage mode (no DATABASE_URL) does not cause 500 errors.
 *
 * Note: workspace_symbols queries still use db directly since the indexer
 * subsystem requires a real database. Symbol endpoints return 409 when
 * indexStatus !== "ready", which guards against MemStorage use.
 */
import { type Router, type Request, type Response } from "express";
import { z } from "zod";
import { SYMBOL_KINDS } from "@shared/schema";
import type { WorkspaceRow } from "@shared/schema";
import type { IStorage } from "../storage";
import { WorkspaceManager } from "../workspace/manager.js";
import { CodeChatService } from "../workspace/code-chat.js";
import { WorkspaceIndexer } from "../workspace/indexer.js";
import { DependencyGraph } from "../workspace/dependency-graph.js";
import type { Gateway } from "../gateway/index.js";
import { configLoader } from "../config/loader.js";
import type { ProjectConfigResponse } from "@shared/types";
import type { WsManager } from "../ws/manager.js";

// --- Validation schemas ------------------------------------------------------

const ConnectWorkspaceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("local"),
    path: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({
    type: z.literal("remote"),
    url: z.string().url().startsWith("https://"),
    branch: z.string().optional(),
    name: z.string().optional(),
  }),
]);

const WriteFileSchema = z.object({
  content: z.string(),
  confirmed: z.boolean().optional(),
});

const CommitSchema = z.object({
  message: z.string().min(1).max(500),
});

const BranchSchema = z.object({
  name: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_/.-]+$/, "Invalid branch name"),
});

const SwitchBranchSchema = z.object({
  branch: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_/.-]+$/, "Invalid branch name"),
});

const ReviewSchema = z.object({
  filePaths: z.array(z.string().min(1)).min(1).max(20),
  models: z.array(z.string().min(1)).min(1).max(10),
  prompt: z.string().max(1000).optional(),
});

const ChatSchema = z.object({
  message: z.string().min(1).max(10000),
  modelSlug: z.string().min(1),
  context: z
    .object({
      filePaths: z.array(z.string()).optional(),
      selection: z.object({ content: z.string() }).optional(),
    })
    .optional(),
});

// --- Phase 6.9 Validation Schemas --------------------------------------------

const WorkspaceIdParamsSchema = z.object({
  id: z.string().min(1),
});

const SymbolNameParamsSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(256),
});

const SymbolSearchQuerySchema = z.object({
  q: z.string().min(1).max(256),
  kind: z.enum(SYMBOL_KINDS).optional(),
  scope: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// --- Per-workspace sync rate limiter (A4) ------------------------------------
// Allows at most one sync per workspace per SYNC_COOLDOWN_MS milliseconds.

const SYNC_COOLDOWN_MS = 60_000; // 60 seconds
const lastSyncTime = new Map<string, number>();

function isSyncThrottled(workspaceId: string): boolean {
  const last = lastSyncTime.get(workspaceId);
  if (last === undefined) return false;
  return Date.now() - last < SYNC_COOLDOWN_MS;
}

function recordSync(workspaceId: string): void {
  lastSyncTime.set(workspaceId, Date.now());
}

// --- Per-workspace index rate limiter (Phase 6.9) ----------------------------
// Max 1 manual trigger per workspace per 5 minutes.

const INDEX_COOLDOWN_MS = 5 * 60_000;
const lastIndexTime = new Map<string, number>();

function isIndexThrottled(workspaceId: string): boolean {
  const last = lastIndexTime.get(workspaceId);
  if (last === undefined) return false;
  return Date.now() - last < INDEX_COOLDOWN_MS;
}

function recordIndex(workspaceId: string): void {
  lastIndexTime.set(workspaceId, Date.now());
}

// --- Route registration ------------------------------------------------------

/** Strip internal paths from error messages to prevent information disclosure. */
function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ENOENT") || msg.includes("no such file or directory")) {
    return "Workspace files are not available. Please sync the workspace first.";
  }
  if (msg.includes("does not exist") && msg.includes("simple-git")) {
    return "Workspace is not synced. Please sync the workspace first.";
  }
  // Strip absolute paths from any remaining messages
  return msg.replace(/\/[^\s'":,]+/g, "[path]");
}

export function registerWorkspaceRoutes(router: Router, gateway: Gateway, wsManager?: WsManager, storage?: IStorage): void {
  // Storage is expected to be passed explicitly by routes.ts.
  // If not provided, fall back to the module-level singleton via dynamic import.
  // This keeps backward compat with tests that don't pass storage.
  const storageRef: IStorage = storage ?? (() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    throw new Error("storage parameter is required for registerWorkspaceRoutes");
  })();

  const manager = new WorkspaceManager();
  const codeChatService = new CodeChatService(gateway);
  const dependencyGraph = new DependencyGraph();

  // Create broadcast helper using WsManager
  function broadcastWsEvent(
    workspaceId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    if (!wsManager) return;
    wsManager.broadcastGlobal({
      type: event as import("@shared/types").WsEventType,
      payload: { workspaceId, ...payload },
      timestamp: new Date().toISOString(),
    });
  }

  const indexer = new WorkspaceIndexer(broadcastWsEvent);

  // -- Workspace CRUD --------------------------------------------------------

  router.get("/api/workspaces", async (_req, res) => {
    try {
      const rows = await storageRef.getWorkspaces();
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.get("/api/workspaces/:id", async (req, res) => {
    try {
      const row = await storageRef.getWorkspace(req.params.id as string);
      if (!row) return res.status(404).json({ error: "Workspace not found" });
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // -- Project config (multiqlti.yaml) ----------------------------------------

  router.get("/api/workspaces/:id/config", async (req, res) => {
    const row = await storageRef.getWorkspace(req.params.id as string);
    if (!row) return res.status(404).json({ error: "Workspace not found" });

    // Only local workspaces have a directly-readable path; remote ones use the clone path
    const workspacePath = row.type === "local" ? row.path : `data/workspaces/${row.id}`;

    try {
      const projectConfig = configLoader.loadProjectConfig(workspacePath);
      const response: ProjectConfigResponse = {
        detected: projectConfig !== null,
        projectConfig: projectConfig as Record<string, unknown> | null,
        diff: projectConfig ? configLoader.diff(projectConfig) : [],
      };
      res.json(response);
    } catch (err) {
      res.status(422).json({ error: (err as Error).message });
    }
  });

  router.post("/api/workspaces", async (req, res) => {
    const parsed = ConnectWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    const userId = req.user?.id;

    try {
      if (parsed.data.type === "local") {
        const { id, name, path: localPath } = await manager.connectLocal(
          parsed.data.path,
          parsed.data.name,
        );
        const row = await storageRef.createWorkspace({
          id,
          name,
          type: "local",
          path: localPath,
          branch: "main",
          status: "active",
          ownerId: userId ?? null,
        } as Parameters<typeof storageRef.createWorkspace>[0]);

        // Trigger auto-indexing in background
        if (row) {
          triggerAutoIndex(row, indexer, dependencyGraph, broadcastWsEvent, storageRef);
        }

        return res.status(201).json(row);
      }

      // Remote
      const id = crypto.randomUUID();
      const name = parsed.data.name ?? new URL(parsed.data.url).pathname.split("/").pop() ?? id;
      const branch = parsed.data.branch ?? "main";

      const row = await storageRef.createWorkspace({
        id,
        name,
        type: "remote",
        path: parsed.data.url,
        branch,
        status: "syncing",
        ownerId: userId ?? null,
      } as Parameters<typeof storageRef.createWorkspace>[0]);

      // Clone in background, then auto-index
      manager
        .cloneRemote(parsed.data.url, id, branch)
        .then(async () => {
          await storageRef.updateWorkspace(id, { status: "active" });
          const updatedRow = await storageRef.getWorkspace(id);
          if (updatedRow) {
            triggerAutoIndex(updatedRow, indexer, dependencyGraph, broadcastWsEvent, storageRef);
          }
        })
        .catch(() =>
          storageRef.updateWorkspace(id, { status: "error" }).catch(() => undefined),
        );

      return res.status(201).json(row);
    } catch (err) {
      return res.status(400).json({ error: sanitizeError(err) });
    }
  });

  router.delete("/api/workspaces/:id", async (req, res) => {
    const row = await storageRef.getWorkspace(req.params.id as string);
    if (!row) return res.status(404).json({ error: "Workspace not found" });

    await storageRef.deleteWorkspace(req.params.id as string);

    if (row.type === "remote") {
      await manager.removeClone(row.id).catch(() => undefined);
    }

    res.json({ message: "Workspace disconnected" });
  });

  router.post("/api/workspaces/:id/sync", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    // Rate limiting: one sync per workspace per 60 s (A4)
    if (isSyncThrottled(row.id)) {
      return res
        .status(429)
        .json({ error: "Sync throttled: please wait 60 seconds between syncs" });
    }

    try {
      await storageRef.updateWorkspace(row.id, { status: "syncing" });
      await manager.sync(row);
      recordSync(row.id);
      await storageRef.updateWorkspace(row.id, { status: "active", lastSyncAt: new Date() });

      // Trigger re-index after sync
      const updatedRow = await storageRef.getWorkspace(row.id);
      if (updatedRow) {
        triggerAutoIndex(updatedRow, indexer, dependencyGraph, broadcastWsEvent, storageRef);
      }

      res.json({ message: "Workspace synced" });
    } catch (err) {
      await storageRef.updateWorkspace(row.id, { status: "error" }).catch(() => undefined);
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // -- File Operations --------------------------------------------------------
  // Express 5 / path-to-regexp v8 requires named wildcards -- bare `*` is not
  // allowed. The `*path` parameter captures everything after /files/ and is
  // accessed via req.params.path.

  router.get("/api/workspaces/:id/files", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    try {
      const subpath = typeof req.query.path === "string" ? req.query.path : "";
      const entries = await manager.listFiles(row, subpath);
      res.json(entries);
    } catch (err) {
      res.status(400).json({ error: sanitizeError(err) });
    }
  });

  router.get("/api/workspaces/:id/files/*path", async (req: Request, res: Response) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const filePath = decodeFilePath(req.params.path);
    if (!filePath) return res.status(400).json({ error: "File path required" });

    try {
      const content = await manager.readFile(row, filePath);
      res.json({ path: filePath, content });
    } catch (err) {
      res.status(400).json({ error: sanitizeError(err) });
    }
  });

  router.put("/api/workspaces/:id/files/*path", async (req: Request, res: Response) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const filePath = decodeFilePath(req.params.path);
    if (!filePath) return res.status(400).json({ error: "File path required" });

    const parsed = WriteFileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    if (parsed.data.confirmed !== true) {
      return res.status(400).json({ error: "File writes require confirmed: true" });
    }

    try {
      await manager.writeFile(row, filePath, parsed.data.content);
      res.json({ message: "File updated" });
    } catch (err) {
      res.status(400).json({ error: sanitizeError(err) });
    }
  });

  router.delete("/api/workspaces/:id/files/*path", async (req: Request, res: Response) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const filePath = decodeFilePath(req.params.path);
    if (!filePath) return res.status(400).json({ error: "File path required" });

    try {
      await manager.deleteFile(row, filePath);
      res.json({ message: "File deleted" });
    } catch (err) {
      res.status(400).json({ error: sanitizeError(err) });
    }
  });

  // -- Git Operations ---------------------------------------------------------

  router.get("/api/workspaces/:id/git/status", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    try {
      const status = await manager.gitStatus(row);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  router.get("/api/workspaces/:id/git/diff", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    try {
      const diff = await manager.gitDiff(row);
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  router.post("/api/workspaces/:id/git/commit", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const parsed = CommitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    try {
      await manager.gitCommit(row, parsed.data.message);
      res.json({ message: "Committed" });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  router.post("/api/workspaces/:id/git/branch", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const parsed = BranchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    try {
      await manager.gitBranch(row, parsed.data.name);
      res.json({ message: `Branch '${parsed.data.name}' created and checked out` });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  router.get("/api/workspaces/:id/git/log", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);

    try {
      const log = await manager.gitLog(row, limit);
      res.json(log);
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // -- Branch Management (A1) ------------------------------------------------

  router.get("/api/workspaces/:id/branches", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    try {
      const result = await manager.listBranches(row);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  router.post("/api/workspaces/:id/branches", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const parsed = SwitchBranchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    try {
      await manager.switchBranch(row, parsed.data.branch);
      await storageRef.updateWorkspace(row.id, { branch: parsed.data.branch });
      res.json({ message: `Switched to branch '${parsed.data.branch}'` });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // -- AI Operations ----------------------------------------------------------

  router.post("/api/workspaces/:id/review", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const parsed = ReviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    try {
      const results = await codeChatService.reviewCode(
        row,
        parsed.data.filePaths,
        parsed.data.models,
        parsed.data.prompt,
      );
      res.json(Object.fromEntries(results));
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  router.post("/api/workspaces/:id/chat", async (req: Request, res: Response) => {
    const row = await getWorkspaceById(req.params.id as string, res, storageRef);
    if (!row) return;

    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const acceptsSSE = (req.headers.accept ?? "").includes("text/event-stream");

    try {
      if (acceptsSSE) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        await codeChatService.chatStream(
          row,
          parsed.data.message,
          parsed.data.modelSlug,
          parsed.data.context,
          (chunk: string) => {
            res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
          },
        );

        res.write(`data: [DONE]\n\n`);
        res.end();
      } else {
        const reply = await codeChatService.chat(
          row,
          parsed.data.message,
          parsed.data.modelSlug,
          parsed.data.context,
        );
        res.json({ reply });
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: sanitizeError(err) });
      } else {
        res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
        res.end();
      }
    }
  });

  // -- Phase 6.9: Workspace Claim ---------------------------------------------

  /**
   * POST /api/workspaces/:id/claim
   * Sets ownerId to the authenticated user if currently null.
   * Returns 409 if already claimed by another user.
   */
  router.post("/api/workspaces/:id/claim", async (req, res) => {
    const params = WorkspaceIdParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: params.error.message });

    const userId = req.user!.id;
    const row = await storageRef.getWorkspace(params.data.id);
    if (!row) return res.status(404).json({ error: "Workspace not found" });

    if (row.ownerId !== null && row.ownerId !== userId) {
      return res.status(409).json({ error: "Workspace already claimed by another user" });
    }

    if (row.ownerId === userId) {
      return res.json({ message: "Workspace already owned by you", workspaceId: row.id });
    }

    await storageRef.updateWorkspace(row.id, { ownerId: userId });

    res.json({ message: "Workspace claimed", workspaceId: row.id });
  });

  // -- Phase 6.9: Index Trigger -----------------------------------------------

  /**
   * POST /api/workspaces/:id/index
   * Manually trigger (re-)indexing. Returns immediately, progress via WS.
   */
  router.post("/api/workspaces/:id/index", async (req, res) => {
    const params = WorkspaceIdParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: params.error.message });

    const userId = req.user!.id;
    const row = await getOwnedWorkspace(params.data.id, userId, res, storageRef);
    if (!row) return;

    if (row.indexStatus === "indexing") {
      return res.status(409).json({ error: "Index already in progress" });
    }

    if (isIndexThrottled(row.id)) {
      return res.status(429).json({ error: "Index throttled: please wait 5 minutes between manual triggers" });
    }

    await storageRef.updateWorkspace(row.id, { indexStatus: "indexing" });

    recordIndex(row.id);

    // Fire and forget
    indexer
      .indexWorkspace({ ...row, indexStatus: "indexing" })
      .then(async (result) => {
        await storageRef.updateWorkspace(row.id, { indexStatus: "ready" });
        broadcastWsEvent(row.id, "workspace:index_complete", {
          symbolCount: result.symbolCount,
          indexedFiles: result.indexedFiles,
          skippedFiles: result.skippedFiles,
          deletedFiles: result.deletedFiles,
          errorsCount: result.errors.length,
          durationMs: result.durationMs,
        });
        dependencyGraph.invalidateCache(row.id);
      })
      .catch(async (err) => {
        await storageRef.updateWorkspace(row.id, { indexStatus: "error" }).catch(() => undefined);
        broadcastWsEvent(row.id, "workspace:index_error", {
          message: (err as Error).message,
        });
      });

    res.status(202).json({
      message: "Indexing started",
      workspaceId: row.id,
      indexStatus: "indexing",
    });
  });

  // -- Phase 6.9: Dependency Graph --------------------------------------------

  /**
   * GET /api/workspaces/:id/dependency-graph
   * Returns full file dependency graph for reactflow rendering.
   */
  router.get("/api/workspaces/:id/dependency-graph", async (req, res) => {
    const params = WorkspaceIdParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: params.error.message });

    const userId = req.user!.id;
    const row = await getOwnedWorkspace(params.data.id, userId, res, storageRef);
    if (!row) return;

    if (row.indexStatus !== "ready") {
      return res.status(409).json({
        error: "Workspace not yet indexed",
        indexStatus: row.indexStatus,
      });
    }

    try {
      const graph = await dependencyGraph.buildGraph(row.id);
      res.json(graph);
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // -- Phase 6.9: Symbol References -------------------------------------------

  /**
   * GET /api/workspaces/:id/symbols/:name/references
   * Find all files that reference a named symbol.
   */
  router.get("/api/workspaces/:id/symbols/:name/references", async (req, res) => {
    const params = SymbolNameParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: params.error.message });

    const userId = req.user!.id;
    const row = await getOwnedWorkspace(params.data.id, userId, res, storageRef);
    if (!row) return;

    try {
      const files = await dependencyGraph.findReferences(row.id, params.data.name);
      res.json({
        symbolName: params.data.name,
        files,
        total: files.length,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // -- Phase 6.9: Symbol Definition -------------------------------------------

  /**
   * GET /api/workspaces/:id/symbols/:name/definition
   * Find the definition location of a named symbol.
   */
  router.get("/api/workspaces/:id/symbols/:name/definition", async (req, res) => {
    const params = SymbolNameParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: params.error.message });

    const userId = req.user!.id;
    const row = await getOwnedWorkspace(params.data.id, userId, res, storageRef);
    if (!row) return;

    try {
      const definition = await dependencyGraph.findDefinition(row.id, params.data.name);
      res.json({
        symbolName: params.data.name,
        definition,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // -- Phase 6.9: Symbol Search -----------------------------------------------

  /**
   * GET /api/workspaces/:id/symbols
   * Upgraded symbol search -- queries workspace_symbols table.
   */
  router.get("/api/workspaces/:id/symbols", async (req, res) => {
    const params = WorkspaceIdParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: params.error.message });

    const queryParsed = SymbolSearchQuerySchema.safeParse(req.query);
    if (!queryParsed.success) return res.status(400).json({ error: queryParsed.error.message });

    const userId = req.user!.id;
    const row = await getOwnedWorkspace(params.data.id, userId, res, storageRef);
    if (!row) return;

    if (row.indexStatus !== "ready") {
      return res.status(409).json({
        error: "Workspace not yet indexed",
        indexStatus: row.indexStatus,
      });
    }

    try {
      const { q, kind, scope, limit } = queryParsed.data;
      let results = await indexer.getSymbols(row.id, q, kind, limit);

      // Apply scope filter (file path prefix)
      if (scope) {
        results = results.filter((s) => s.filePath.startsWith(scope));
      }

      // Compute usageCount: count of imports pointing to each symbol's file
      const usageMap = await buildUsageCountMap(row.id);

      res.json({
        query: q,
        results: results.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          file: s.filePath,
          line: s.line,
          col: s.col,
          signature: s.signature,
          usageCount: usageMap.get(s.filePath) ?? 0,
        })),
        total: results.length,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });
}

// --- Helpers -----------------------------------------------------------------

async function getWorkspaceById(id: string, res: Response, storage: IStorage): Promise<WorkspaceRow | null> {
  const row = await storage.getWorkspace(id);
  if (!row) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  return row;
}

/**
 * Load workspace by ID and verify ownership.
 * BLOCKS requests where ownerId IS NULL (IDOR prevention for Phase 6.9 endpoints).
 */
async function getOwnedWorkspace(
  id: string,
  userId: string,
  res: Response,
  storage: IStorage,
): Promise<WorkspaceRow | null> {
  const row = await storage.getWorkspace(id);
  if (!row) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }

  // Null ownerId = ownership not established -- block access to sensitive endpoints
  if (row.ownerId === null) {
    res.status(403).json({
      error: "Workspace ownership not established. Re-connect this workspace to claim it.",
    });
    return null;
  }

  if (row.ownerId !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }

  return row;
}

/**
 * Trigger auto-indexing in the background after workspace connect/sync.
 * Fire-and-forget -- never throws.
 */
function triggerAutoIndex(
  row: WorkspaceRow,
  indexer: WorkspaceIndexer,
  depGraph: DependencyGraph,
  broadcastWsEvent: (id: string, event: string, payload: Record<string, unknown>) => void,
  storage: IStorage,
): void {
  setImmediate(async () => {
    try {
      await storage.updateWorkspace(row.id, { indexStatus: "indexing" });

      const result = await indexer.indexWorkspace({ ...row, indexStatus: "indexing" });

      await storage.updateWorkspace(row.id, { indexStatus: "ready" });

      broadcastWsEvent(row.id, "workspace:index_complete", {
        symbolCount: result.symbolCount,
        indexedFiles: result.indexedFiles,
        skippedFiles: result.skippedFiles,
        deletedFiles: result.deletedFiles,
        errorsCount: result.errors.length,
        durationMs: result.durationMs,
      });

      depGraph.invalidateCache(row.id);
    } catch {
      await storage.updateWorkspace(row.id, { indexStatus: "error" }).catch(() => undefined);
    }
  });
}

/**
 * Build a map of filePath -> importedByCount from workspace_symbols.
 * Used to compute usageCount in symbol search results.
 *
 * Note: This still uses the db module directly because workspace_symbols are
 * managed by the WorkspaceIndexer (which also uses db directly). These queries
 * only run when indexStatus === "ready", which requires a real database.
 * In MemStorage mode this is unreachable, but we catch errors gracefully.
 */
async function buildUsageCountMap(workspaceId: string): Promise<Map<string, number>> {
  try {
    // Dynamic import to avoid crashes when DATABASE_URL is unset
    const { db } = await import("../db.js");
    const { workspaceSymbols } = await import("@shared/schema");
    const { eq, and } = await import("drizzle-orm");

    const importRows = await db
      .select({ name: workspaceSymbols.name, filePath: workspaceSymbols.filePath })
      .from(workspaceSymbols)
      .where(
        and(
          eq(workspaceSymbols.workspaceId, workspaceId),
          eq(workspaceSymbols.kind, "import"),
        ),
      );

    const map = new Map<string, number>();
    for (const row of importRows) {
      if (row.name.startsWith(".")) {
        map.set(row.name, (map.get(row.name) ?? 0) + 1);
      }
    }
    return map;
  } catch {
    // MemStorage mode or db unavailable -- return empty map
    return new Map();
  }
}

/**
 * Decode the file path captured by the Express 5 named wildcard `*path`.
 * Returns null if the path is empty.
 */
function decodeFilePath(rawPath: string | string[] | undefined): string | null {
  if (!rawPath) return null;
  const raw = Array.isArray(rawPath) ? rawPath[0] : rawPath;
  if (!raw) return null;
  const fp = decodeURIComponent(raw);
  return fp.length > 0 ? fp : null;
}
