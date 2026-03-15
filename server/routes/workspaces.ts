import { type Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { workspaces } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { WorkspaceRow } from "@shared/schema";
import { WorkspaceManager } from "../workspace/manager";
import { CodeChatService } from "../workspace/code-chat";
import type { Gateway } from "../gateway/index";
import { configLoader } from "../config/loader";
import type { ProjectConfigResponse } from "@shared/types";

// ─── Validation schemas ───────────────────────────────────────────────────────

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

// ─── Per-workspace sync rate limiter (A4) ────────────────────────────────────
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

// ─── Route registration ───────────────────────────────────────────────────────

export function registerWorkspaceRoutes(router: Router, gateway: Gateway): void {
  const manager = new WorkspaceManager();
  const codeChatService = new CodeChatService(gateway);

  // ── Workspace CRUD ──────────────────────────────────────────────────────────

  router.get("/api/workspaces", async (_req, res) => {
    const rows = await db.select().from(workspaces).orderBy(workspaces.createdAt);
    res.json(rows);
  });

  router.get("/api/workspaces/:id", async (req, res) => {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, req.params.id as string));
    if (!row) return res.status(404).json({ error: "Workspace not found" });
    res.json(row);
  });

  // ── Project config (multiqlti.yaml) ─────────────────────────────────────────

  router.get("/api/workspaces/:id/config", async (req, res) => {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, req.params.id as string));
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

    try {
      if (parsed.data.type === "local") {
        const { id, name, path: localPath } = await manager.connectLocal(
          parsed.data.path,
          parsed.data.name,
        );
        const [row] = await db
          .insert(workspaces)
          .values({ id, name, type: "local", path: localPath, branch: "main", status: "active" })
          .returning();
        return res.status(201).json(row);
      }

      // Remote
      const id = crypto.randomUUID();
      const name = parsed.data.name ?? new URL(parsed.data.url).pathname.split("/").pop() ?? id;
      const branch = parsed.data.branch ?? "main";

      const [row] = await db
        .insert(workspaces)
        .values({ id, name, type: "remote", path: parsed.data.url, branch, status: "syncing" })
        .returning();

      // Clone in background, update status when done
      manager
        .cloneRemote(parsed.data.url, id, branch)
        .then(() =>
          db.update(workspaces).set({ status: "active" }).where(eq(workspaces.id, id)),
        )
        .catch(() =>
          db.update(workspaces).set({ status: "error" }).where(eq(workspaces.id, id)),
        );

      return res.status(201).json(row);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/workspaces/:id", async (req, res) => {
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, req.params.id as string));
    if (!row) return res.status(404).json({ error: "Workspace not found" });

    await db.delete(workspaces).where(eq(workspaces.id, req.params.id as string));

    if (row.type === "remote") {
      await manager.removeClone(row.id).catch(() => undefined);
    }

    res.json({ message: "Workspace disconnected" });
  });

  router.post("/api/workspaces/:id/sync", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    // Rate limiting: one sync per workspace per 60 s (A4)
    if (isSyncThrottled(row.id)) {
      return res
        .status(429)
        .json({ error: "Sync throttled: please wait 60 seconds between syncs" });
    }

    try {
      await db.update(workspaces).set({ status: "syncing" }).where(eq(workspaces.id, row.id));
      await manager.sync(row);
      recordSync(row.id);
      await db
        .update(workspaces)
        .set({ status: "active", lastSyncAt: new Date() })
        .where(eq(workspaces.id, row.id));
      res.json({ message: "Workspace synced" });
    } catch (err) {
      await db.update(workspaces).set({ status: "error" }).where(eq(workspaces.id, row.id));
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── File Operations ─────────────────────────────────────────────────────────
  // Express 5 / path-to-regexp v8 requires named wildcards — bare `*` is not
  // allowed. The `*path` parameter captures everything after /files/ and is
  // accessed via req.params.path.

  router.get("/api/workspaces/:id/files", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    try {
      const subpath = typeof req.query.path === "string" ? req.query.path : "";
      const entries = await manager.listFiles(row, subpath);
      res.json(entries);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get("/api/workspaces/:id/files/*path", async (req: Request, res: Response) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    const filePath = decodeFilePath(req.params.path);
    if (!filePath) return res.status(400).json({ error: "File path required" });

    try {
      const content = await manager.readFile(row, filePath);
      res.json({ path: filePath, content });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.put("/api/workspaces/:id/files/*path", async (req: Request, res: Response) => {
    const row = await getWorkspaceById(req.params.id as string, res);
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
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/workspaces/:id/files/*path", async (req: Request, res: Response) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    const filePath = decodeFilePath(req.params.path);
    if (!filePath) return res.status(400).json({ error: "File path required" });

    try {
      await manager.deleteFile(row, filePath);
      res.json({ message: "File deleted" });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Git Operations ──────────────────────────────────────────────────────────

  router.get("/api/workspaces/:id/git/status", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    try {
      const status = await manager.gitStatus(row);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/workspaces/:id/git/diff", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    try {
      const diff = await manager.gitDiff(row);
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/workspaces/:id/git/commit", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    const parsed = CommitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    try {
      await manager.gitCommit(row, parsed.data.message);
      res.json({ message: "Committed" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/workspaces/:id/git/branch", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    const parsed = BranchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    try {
      await manager.gitBranch(row, parsed.data.name);
      res.json({ message: `Branch '${parsed.data.name}' created and checked out` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/workspaces/:id/git/log", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);

    try {
      const log = await manager.gitLog(row, limit);
      res.json(log);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Branch Management (A1) ──────────────────────────────────────────────────

  /**
   * GET /api/workspaces/:id/branches — list all branches (local + remote-tracking).
   * Returns { current: string, branches: string[] }
   */
  router.get("/api/workspaces/:id/branches", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    try {
      const result = await manager.listBranches(row);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/workspaces/:id/branches — switch to an existing branch.
   * Body: { branch: string }
   * Distinct from POST /git/branch which creates a new branch.
   */
  router.post("/api/workspaces/:id/branches", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    const parsed = SwitchBranchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    try {
      await manager.switchBranch(row, parsed.data.branch);
      // Update stored branch name in DB
      await db
        .update(workspaces)
        .set({ branch: parsed.data.branch })
        .where(eq(workspaces.id, row.id));
      res.json({ message: `Switched to branch '${parsed.data.branch}'` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── AI Operations ───────────────────────────────────────────────────────────

  router.post("/api/workspaces/:id/review", async (req, res) => {
    const row = await getWorkspaceById(req.params.id as string, res);
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/workspaces/:id/chat — AI chat about workspace code (A2).
   *
   * Two modes based on Accept header:
   *   text/event-stream  → SSE streaming (data: {"chunk":"..."} per token, data: [DONE] at end)
   *   application/json   → Non-streaming fallback ({ reply: string })
   */
  router.post("/api/workspaces/:id/chat", async (req: Request, res: Response) => {
    const row = await getWorkspaceById(req.params.id as string, res);
    if (!row) return;

    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const acceptsSSE = (req.headers.accept ?? "").includes("text/event-stream");

    try {
      if (acceptsSSE) {
        // ── SSE streaming path ──
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
        // ── Non-streaming fallback (backward compatible) ──
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
        res.status(500).json({ error: (err as Error).message });
      } else {
        res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
        res.end();
      }
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getWorkspaceById(id: string, res: Response): Promise<WorkspaceRow | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  if (!row) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  return row;
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
