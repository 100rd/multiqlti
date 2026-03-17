# Phase 6.9 — Semantic Workspace Indexing: Architecture

**Date**: 2026-03-17
**Status**: APPROVED FOR IMPLEMENTATION
**Branch**: worktree-phase-6.9-architect

---

## Table of Contents

1. [Technology Decisions](#1-technology-decisions)
2. [Complete DB Schema](#2-complete-db-schema)
3. [WorkspaceIndexer Class Interface](#3-workspaceindexer-class-interface)
4. [DependencyGraph Class Interface](#4-dependencygraph-class-interface)
5. [API Endpoints (all 5)](#5-api-endpoints)
6. [Frontend Component Tree](#6-frontend-component-tree)
7. [WebSocket Event Schema](#7-websocket-event-schema)
8. [Test Strategy](#8-test-strategy)
9. [Security Checklist](#9-security-checklist)
10. [Performance Targets](#10-performance-targets)
11. [Implementation Order](#11-implementation-order)

---

## 1. Technology Decisions

### 1.1 AST Parser: `@swc/core`

**Chosen**: `@swc/core`
**Rejected**: `tree-sitter` (Node bindings are unstable on ARM/Linux combos; requires native compilation per platform; separate WASM bundles for each language)

**Rationale for `@swc/core`**:
- Already present in many TS toolchains, well-maintained by Vercel
- Single `parseSync`/`parse` API handles TypeScript, TSX, JavaScript, and JSX natively
- Returns a typed ESTree-compatible AST (`Module`) — no grammars to maintain
- `@swc/core` ships prebuilt native binaries for all major platforms (darwin-arm64, linux-x64, linux-arm64)
- No external process spawn needed — direct in-process parsing for TS/JS
- For Python/Go: subprocess-based parsing (see §3.5) deferred to stretch goal

### 1.2 File Hash Strategy: SHA-256 via Node `crypto`

**Chosen**: SHA-256
**Rejected**: MD5 (cryptographic weakness, though fine for change detection), xxhash (extra npm dep)

**Rationale**: Node `crypto.createHash('sha256')` ships with Node.js — no extra dependency. Performance is acceptable: ~400 MB/s on modern hardware. For a 10k-file repo with average 5 KB files (50 MB total), hashing takes ~125ms — well within budget. The `fileHash` column in `workspace_symbols` enables exact incremental skipping: if SHA-256 of current file matches stored hash, skip re-parse.

**Implementation**: Hash computed as a streaming `createHash` over the raw file buffer before parsing. Store as 64-char hex string.

### 1.3 Dependency Graph: In-Memory Adjacency Map + DB-Backed Persistence

Import statements are extracted from already-parsed SWC AST nodes (`ImportDeclaration`, `CallExpression` with `require`). No re-parse needed. The graph is built in memory at request time from the `workspace_symbols` table (import kind records) and cached in a `Map<string, string[]>` per workspace. Cache invalidation: on index completion, invalidate the workspace's graph cache.

### 1.4 Frontend: `reactflow ^11.11.4`

`reactflow` is already in `package.json` — use it directly. Import as `import ReactFlow, { ... } from 'reactflow'`. Do **not** use `@xyflow/react` (different package, not installed).

### 1.5 Background Indexing: `setImmediate`-deferred Promise chain

Indexing is triggered fire-and-forget from route handlers. The HTTP response returns immediately (201/200) and indexing runs in the background. Progress is broadcast via the existing `ws` WebSocket server. No separate worker threads needed for MVP — the async I/O model handles concurrency naturally. For large repos, a BullMQ queue can be added later.

### 1.6 Workspace Ownership Gap & Resolution

**Problem identified during architecture review**: The existing `workspaces` table has no `ownerId` column. Current routes do not verify that the authenticated user owns the workspace they're accessing. Phase 6.9 adds `owner_id` as part of the 0003 migration and enforces it on all new endpoints.

Existing endpoints (pre-6.9) are **not** retroactively changed in this phase — that scope belongs to a dedicated security hardening phase. New endpoints introduced in 6.9 **will** enforce ownership.

---

## 2. Complete DB Schema

### 2.1 Migration File Name

```
migrations/0003_phase_6_9_workspace_index.sql
```

### 2.2 SQL Migration (`0003_phase_6_9_workspace_index.sql`)

```sql
-- Phase 6.9: Semantic Workspace Indexing
-- Adds workspace_symbols table and index_status/owner_id columns to workspaces

-- ─── Add owner_id to workspaces (nullable, no cascade — legacy rows stay accessible) ───
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS index_status TEXT NOT NULL DEFAULT 'idle';

COMMENT ON COLUMN workspaces.owner_id IS 'User who connected this workspace. Enforced on Phase 6.9+ endpoints.';
COMMENT ON COLUMN workspaces.index_status IS 'idle | indexing | ready | error';

-- ─── workspace_symbols table ──────────────────────────────────────────────────
CREATE TABLE workspace_symbols (
  id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,    -- 'function' | 'class' | 'interface' | 'type' | 'variable' | 'export' | 'import'
  line          INTEGER NOT NULL,
  col           INTEGER NOT NULL DEFAULT 0,
  signature     TEXT,
  file_hash     TEXT NOT NULL,    -- SHA-256 hex of file at index time
  exported_from TEXT,             -- module specifier if this is a re-export
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT workspace_symbols_unique
    UNIQUE (workspace_id, file_path, name, kind)
);

-- Index: symbol lookup by workspace + name (symbol search)
CREATE INDEX workspace_symbols_name_idx
  ON workspace_symbols (workspace_id, name);

-- Index: file-level lookup (incremental hash check, stale cleanup)
CREATE INDEX workspace_symbols_file_idx
  ON workspace_symbols (workspace_id, file_path);

-- Index: kind filter (e.g. "show only functions")
CREATE INDEX workspace_symbols_kind_idx
  ON workspace_symbols (workspace_id, kind);

COMMENT ON TABLE workspace_symbols IS 'AST-extracted symbols per workspace file. Supports incremental re-indexing via file_hash. Phase 6.9.';
```

### 2.3 Drizzle Schema Additions (`shared/schema.ts`)

Add to the end of `shared/schema.ts`:

```typescript
// ─── Workspace Index Status ────────────────────────────────────────────────
// Note: the workspaces table itself needs two new columns — ownerId and indexStatus.
// These are applied via migration 0003 and reflected here.

export const WORKSPACE_INDEX_STATUS = ["idle", "indexing", "ready", "error"] as const;
export type WorkspaceIndexStatus = typeof WORKSPACE_INDEX_STATUS[number];

export const SYMBOL_KINDS = [
  "function",
  "class",
  "interface",
  "type",
  "variable",
  "export",
  "import",
] as const;
export type SymbolKind = typeof SYMBOL_KINDS[number];

// ─── workspace_symbols ─────────────────────────────────────────────────────

export const workspaceSymbols = pgTable(
  "workspace_symbols",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: varchar("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().$type<SymbolKind>(),
    line: integer("line").notNull(),
    col: integer("col").notNull().default(0),
    signature: text("signature"),
    fileHash: text("file_hash").notNull(),
    exportedFrom: text("exported_from"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index("workspace_symbols_name_idx").on(table.workspaceId, table.name),
    fileIdx: index("workspace_symbols_file_idx").on(table.workspaceId, table.filePath),
    kindIdx: index("workspace_symbols_kind_idx").on(table.workspaceId, table.kind),
    uniqueSymbol: unique("workspace_symbols_unique").on(
      table.workspaceId,
      table.filePath,
      table.name,
      table.kind,
    ),
  }),
);

export const insertWorkspaceSymbolSchema = createInsertSchema(workspaceSymbols).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWorkspaceSymbol = z.infer<typeof insertWorkspaceSymbolSchema>;
export type WorkspaceSymbolRow = typeof workspaceSymbols.$inferSelect;
```

**Modification to existing `workspaces` pgTable** — add two columns to the drizzle definition:

```typescript
// In the existing workspaces pgTable definition, add:
ownerId: text("owner_id").references(() => users.id, { onDelete: "setNull" }),
indexStatus: text("index_status").notNull().default("idle").$type<WorkspaceIndexStatus>(),
```

Updated `WorkspaceRow` type will automatically include these via `$inferSelect`.

---

## 3. WorkspaceIndexer Class Interface

### 3.1 Supporting Types

```typescript
// server/workspace/indexer.ts

import type { WorkspaceRow, WorkspaceSymbolRow, SymbolKind } from "@shared/schema";

/** Result returned after indexing a full workspace. */
export interface IndexResult {
  workspaceId: string;
  totalFiles: number;
  indexedFiles: number;     // files actually parsed (new or changed)
  skippedFiles: number;     // files with unchanged hash
  deletedFiles: number;     // files removed since last index
  symbolCount: number;      // total symbols now stored
  errors: IndexError[];
  durationMs: number;
}

/** Per-file error record — indexer continues on error. */
export interface IndexError {
  filePath: string;
  message: string;
}

/** Subset of WorkspaceSymbolRow used for search results. */
export interface SymbolSearchResult {
  id: string;
  workspaceId: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
  line: number;
  col: number;
  signature: string | null;
  fileHash: string;
  exportedFrom: string | null;
}

/** A symbol extracted from a single file by the AST parser. */
export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  col: number;
  signature: string | null;
  exportedFrom: string | null;
}

/** File indexing result for a single file. */
export interface FileIndexResult {
  filePath: string;
  fileHash: string;
  symbols: ParsedSymbol[];
  skipped: boolean;         // true if hash matched, no re-parse
  error: string | null;
}
```

### 3.2 Class Interface

```typescript
export class WorkspaceIndexer {
  /**
   * Index all indexable files in a workspace.
   *
   * Algorithm:
   * 1. Walk workspace root (reusing WorkspaceManager.resolveRoot pattern)
   * 2. For each TS/JS/TSX/JSX file: compute SHA-256, compare with stored hash
   * 3. If hash matches: skip (increment skippedFiles)
   * 4. If hash differs or file is new: parse with @swc/core, upsert symbols
   * 5. Delete symbols for files no longer present in the workspace
   * 6. Update workspace.indexStatus throughout
   */
  indexWorkspace(workspace: WorkspaceRow): Promise<IndexResult>;

  /**
   * Index a single file within a workspace.
   *
   * Security: uses guardPath pattern (resolved path must stay within workspace root).
   * Graceful on parse error: returns empty symbol array + error string, does NOT throw.
   */
  indexFile(workspace: WorkspaceRow, filePath: string): Promise<FileIndexResult>;

  /**
   * Query symbols from DB for a workspace.
   *
   * @param workspaceId - workspace to search within
   * @param query - case-insensitive prefix/contains match on symbol name
   * @param kind - optional filter by SymbolKind
   * @param limit - max results, default 50, max 200
   */
  getSymbols(
    workspaceId: string,
    query: string,
    kind?: SymbolKind,
    limit?: number,
  ): Promise<SymbolSearchResult[]>;

  /**
   * Return SHA-256 hex of a file's raw buffer.
   * Public to allow DependencyGraph to reuse without re-reading the file.
   */
  hashFile(absolutePath: string): Promise<string>;

  /**
   * List all file paths currently indexed for a workspace (for stale detection).
   */
  listIndexedFiles(workspaceId: string): Promise<string[]>;
}
```

### 3.3 Internal Implementation Notes

**File discovery**: Use `fs.readdir` recursively (same pattern as `WorkspaceManager.readDir`). Skip `SKIP_DIRS` set (node_modules, .git, dist, .next, __pycache__). Only parse files with extensions: `.ts`, `.tsx`, `.js`, `.jsx`.

**SWC parse call**:
```typescript
import { parseSync } from "@swc/core";

const module = parseSync(source, {
  syntax: isTypeScript ? "typescript" : "ecmascript",
  tsx: isTsx,
  decorators: true,
  dynamicImport: true,
});
```

**Symbol extraction from SWC AST** (visit `module.body`):
- `ExportDeclaration` / `ExportDefaultDeclaration` → extract inner declaration
- `FunctionDeclaration` / `TsDeclaration` (FunctionDeclaration) → kind: `"function"`
- `ClassDeclaration` → kind: `"class"`
- `TsInterfaceDeclaration` → kind: `"interface"`
- `TsTypeAliasDeclaration` → kind: `"type"`
- `VariableDeclaration` → kind: `"variable"` (for each declarator)
- `ImportDeclaration` → kind: `"import"`, `name` = module specifier, `exportedFrom` = specifier
- `ExportNamedDeclaration` with `source` → kind: `"export"`, `exportedFrom` = source value

**Signature construction**:
- Functions: reconstruct from params (name+type if available) and return type
- Classes: class name + `extends` clause if present
- Interfaces: interface name
- Variables: `const/let/var name: type` if type annotation present

**Batch upsert**: collect all symbols per file, then use drizzle's `insert().onConflictDoUpdate()` with the unique constraint. This handles both insert and update in one DB round-trip.

**Stale file cleanup**: after full index pass, delete rows where `filePath NOT IN (currentFilePaths)` for this `workspaceId`. Use a `NOT IN` query with the set of files that exist on disk.

### 3.4 Incremental Index Flow

```
indexWorkspace()
  │
  ├─ resolveRoot(workspace) → workspaceRoot
  ├─ collectIndexableFiles(workspaceRoot) → string[]  (walk fs)
  ├─ for each file (concurrency: Promise.all batches of 50):
  │    ├─ hashFile(absolutePath) → currentHash
  │    ├─ query DB: SELECT file_hash WHERE workspace_id+file_path
  │    ├─ if hash matches → skip (skippedFiles++)
  │    └─ else → indexFile(workspace, relativePath)
  │         ├─ parseSync(source) → SWC Module AST
  │         ├─ extractSymbols(ast) → ParsedSymbol[]
  │         ├─ upsert to workspace_symbols (batch)
  │         └─ FileIndexResult { symbols, fileHash, skipped: false }
  │
  └─ deleteStaleSymbols(workspaceId, currentFilePaths)
```

### 3.5 Stretch: Python and Go (subprocess)

Python: `python3 -c "import ast, json, sys; ..."` — pass file path, parse with `ast.parse`, walk for `FunctionDef`, `ClassDef`, `Assign`, emit JSON to stdout.

Go: `go run` a tiny extractor script using `go/parser` + `go/ast`, emit JSON.

Both: subprocess with a 10-second timeout, JSON output parsed to `ParsedSymbol[]`. Errors from subprocess → skip file, log warning. Not included in MVP scope.

---

## 4. DependencyGraph Class Interface

### 4.1 Supporting Types

```typescript
// server/workspace/dependency-graph.ts

/** Node in the dependency graph — represents one file. */
export interface DGNode {
  id: string;       // relative file path (unique within workspace)
  label: string;    // basename of the file
  importCount: number;    // how many files this node imports
  importedByCount: number; // how many files import THIS file (impact radius)
}

/** Directed edge: source file imports target file. */
export interface DGEdge {
  id: string;       // `${source}→${target}`
  source: string;   // relative file path
  target: string;   // relative file path (resolved)
}

/** Full graph response. */
export interface DependencyGraphResponse {
  nodes: DGNode[];
  edges: DGEdge[];
}

/** One file that references a symbol. */
export interface RefResult {
  file: string;         // relative file path
  line: number;
  col: number;
  snippet: string | null; // up to 120 chars of context line
}

/** Symbol definition location. */
export interface SymbolDefinition {
  file: string;
  line: number;
  col: number;
  signature: string | null;
}
```

### 4.2 Class Interface

```typescript
export class DependencyGraph {
  /**
   * Build and return the full dependency graph for a workspace.
   *
   * Source: reads `import` kind symbols from workspace_symbols table.
   * The `name` column of an import symbol = the module specifier string.
   * Resolution: relative imports (starting with '.') are resolved to absolute paths
   * and normalized to workspace-relative paths. Bare module specifiers (npm packages)
   * are excluded from the graph (only show internal deps).
   *
   * Returns: DGNode[] and DGEdge[] ready for reactflow rendering.
   * Caches per workspaceId, invalidated on workspace:index_complete event.
   */
  buildGraph(workspaceId: string): Promise<DependencyGraphResponse>;

  /**
   * Find all files that reference a named symbol.
   *
   * Searches workspace_symbols for symbols with matching name,
   * then cross-references import records to find files that import
   * from the file where the symbol is defined.
   *
   * @param workspaceId
   * @param symbolName - exact match
   */
  findReferences(workspaceId: string, symbolName: string): Promise<RefResult[]>;

  /**
   * Find the definition location of a named symbol.
   *
   * Searches workspace_symbols excluding `import` kind (definitions only).
   * Returns the first match. If multiple definitions exist (e.g. overloads),
   * returns the one with lowest line number in the file that exports it.
   */
  findDefinition(workspaceId: string, symbolName: string): Promise<SymbolDefinition | null>;

  /**
   * Invalidate cached graph for a workspace.
   * Called automatically on workspace:index_complete.
   */
  invalidateCache(workspaceId: string): void;
}
```

### 4.3 Graph Cache Design

```typescript
// In-process LRU-style cache using a Map
// Key: workspaceId
// Value: { graph: DependencyGraphResponse, builtAt: number }
// Max entries: 20 workspaces
// Eviction: LRU on insert when size > 20

private cache: Map<string, { graph: DependencyGraphResponse; builtAt: number }>;
```

No external Redis needed for MVP. For multi-process deployments, this cache is per-process — acceptable since graph builds are fast (< 500ms for typical workspaces).

---

## 5. API Endpoints

All new endpoints:
- Are registered within `registerWorkspaceRoutes` in `server/routes/workspaces.ts`
- Inherit `requireAuth` from the existing `app.use("/api/workspaces", requireAuth)` middleware in `server/routes.ts`
- Verify workspace ownership (req.user.id === workspace.ownerId, with null ownerId fallback for legacy rows)
- Use Zod validation on params and query strings

### Ownership Check Helper (New Private Function)

```typescript
/**
 * Load workspace by ID and verify ownership.
 * Returns null and sends error response if not found or not owned.
 * ownerId of null means pre-6.9 workspace — allow access for backward compat.
 */
async function getOwnedWorkspace(
  id: string,
  userId: string,
  res: Response,
): Promise<WorkspaceRow | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id));
  if (!row) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  // null ownerId = pre-6.9 workspace, skip ownership check for backward compat
  if (row.ownerId !== null && row.ownerId !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return row;
}
```

---

### Endpoint 1: GET `/api/workspaces/:id/dependency-graph`

**Purpose**: Return full file dependency graph for reactflow rendering.

**Auth**: `requireAuth` (middleware), ownership verified via `getOwnedWorkspace`.

**Zod Params Schema**:
```typescript
const WorkspaceIdParamsSchema = z.object({
  id: z.string().uuid("Invalid workspace ID"),
});
```

**Response Schema**:
```typescript
const DGNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  importCount: z.number().int().nonnegative(),
  importedByCount: z.number().int().nonnegative(),
});

const DGEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
});

const DependencyGraphResponseSchema = z.object({
  nodes: z.array(DGNodeSchema),
  edges: z.array(DGEdgeSchema),
});
```

**Error Responses**:
| Status | Condition |
|--------|-----------|
| 400 | Invalid UUID in `:id` |
| 401 | Not authenticated |
| 403 | Not workspace owner |
| 404 | Workspace not found |
| 409 | Workspace not yet indexed (`indexStatus !== 'ready'`) — body: `{ error: "Workspace not yet indexed", indexStatus: "idle" }` |
| 500 | Graph build failure |

**Implementation**:
```typescript
router.get("/api/workspaces/:id/dependency-graph", async (req, res) => {
  const params = WorkspaceIdParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const row = await getOwnedWorkspace(params.data.id, req.user!.id, res);
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
    res.status(500).json({ error: (err as Error).message });
  }
});
```

---

### Endpoint 2: GET `/api/workspaces/:id/symbols/:name/references`

**Purpose**: Find all files that reference (import or use) a named symbol.

**Auth**: `requireAuth` + ownership check.

**Zod Params Schema**:
```typescript
const SymbolNameParamsSchema = z.object({
  id: z.string().uuid("Invalid workspace ID"),
  name: z.string().min(1).max(256),
});
```

**Response Schema**:
```typescript
const RefResultSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  snippet: z.string().nullable(),
});

const ReferencesResponseSchema = z.object({
  symbolName: z.string(),
  files: z.array(RefResultSchema),
  total: z.number().int().nonnegative(),
});
```

**Error Responses**:
| Status | Condition |
|--------|-----------|
| 400 | Invalid `:id` or empty/too-long `:name` |
| 401 | Not authenticated |
| 403 | Not workspace owner |
| 404 | Workspace not found |
| 500 | Query failure |

---

### Endpoint 3: GET `/api/workspaces/:id/symbols/:name/definition`

**Purpose**: Find the definition (file + line + column + signature) of a named symbol.

**Auth**: `requireAuth` + ownership check.

**Zod Params Schema**: Same `SymbolNameParamsSchema` as Endpoint 2.

**Response Schema**:
```typescript
const SymbolDefinitionResponseSchema = z.object({
  symbolName: z.string(),
  definition: z
    .object({
      file: z.string(),
      line: z.number().int().positive(),
      col: z.number().int().nonnegative(),
      signature: z.string().nullable(),
    })
    .nullable(), // null if symbol not found in index
});
```

**Error Responses**:
| Status | Condition |
|--------|-----------|
| 400 | Invalid params |
| 401 | Not authenticated |
| 403 | Not workspace owner |
| 404 | Workspace not found |
| 500 | Query failure |

Note: Symbol not found → 200 with `definition: null`, not 404. This distinguishes "workspace exists but symbol unknown" from "workspace does not exist".

---

### Endpoint 4: GET `/api/workspaces/:id/symbols`

**Purpose**: Upgraded symbol search — queries `workspace_symbols` table.

**Auth**: `requireAuth` + ownership check.

**Zod Query Schema**:
```typescript
const SymbolSearchQuerySchema = z.object({
  q: z.string().min(1).max(256),
  kind: z.enum(SYMBOL_KINDS).optional(),
  scope: z.string().min(1).max(512).optional(), // file path prefix to restrict search
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
```

**Response Schema**:
```typescript
const SymbolSearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(SYMBOL_KINDS),
  file: z.string(),
  line: z.number().int().positive(),
  col: z.number().int().nonnegative(),
  signature: z.string().nullable(),
  usageCount: z.number().int().nonnegative(),
});

const SymbolSearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(SymbolSearchResultSchema),
  total: z.number().int().nonnegative(),
});
```

`usageCount`: count of `import` symbols in `workspace_symbols` where `exportedFrom` resolves to the file where this symbol is defined. Computed as a subquery or via DependencyGraph's reverse-edge count. Returns 0 if not yet computed.

**Error Responses**:
| Status | Condition |
|--------|-----------|
| 400 | Missing `q` / invalid `kind` |
| 401 | Not authenticated |
| 403 | Not workspace owner |
| 404 | Workspace not found |
| 409 | Workspace not indexed yet |
| 500 | Query failure |

---

### Endpoint 5: POST `/api/workspaces/:id/index`

**Purpose**: Manually trigger (re-)indexing of a workspace. Returns immediately; progress via WS events.

**Auth**: `requireAuth` + ownership check.

**Request Body**: None (empty body OK).

**Response Schema**:
```typescript
const IndexTriggerResponseSchema = z.object({
  message: z.literal("Indexing started"),
  workspaceId: z.string(),
  indexStatus: z.literal("indexing"),
});
```

**Error Responses**:
| Status | Condition |
|--------|-----------|
| 401 | Not authenticated |
| 403 | Not workspace owner |
| 404 | Workspace not found |
| 409 | Already indexing — body: `{ error: "Index already in progress" }` |
| 500 | Failed to start indexer |

**Implementation**:
```typescript
router.post("/api/workspaces/:id/index", async (req, res) => {
  const params = WorkspaceIdParamsSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: params.error.message });

  const row = await getOwnedWorkspace(params.data.id, req.user!.id, res);
  if (!row) return;

  if (row.indexStatus === "indexing") {
    return res.status(409).json({ error: "Index already in progress" });
  }

  await db
    .update(workspaces)
    .set({ indexStatus: "indexing" })
    .where(eq(workspaces.id, row.id));

  // Fire and forget — progress via WebSocket
  indexer
    .indexWorkspace({ ...row, indexStatus: "indexing" })
    .then(async (result) => {
      await db
        .update(workspaces)
        .set({ indexStatus: "ready" })
        .where(eq(workspaces.id, row.id));
      broadcastWsEvent(row.id, "workspace:index_complete", {
        symbolCount: result.symbolCount,
        durationMs: result.durationMs,
      });
      dependencyGraph.invalidateCache(row.id);
    })
    .catch(async (err) => {
      await db
        .update(workspaces)
        .set({ indexStatus: "error" })
        .where(eq(workspaces.id, row.id));
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
```

---

## 6. Frontend Component Tree

### 6.1 New Components

```
client/src/components/workspace/
├── DependencyGraph.tsx          ← NEW — reactflow graph view
│   ├── Uses: reactflow (ReactFlow, Background, Controls, MiniMap)
│   ├── Props: { workspaceId: string; onNodeClick: (filePath: string) => void }
│   ├── Data: GET /api/workspaces/:id/dependency-graph
│   └── Sub-components:
│       ├── DGFileNode.tsx       ← Custom node — shows filename + importedByCount badge
│       └── DGImpactPanel.tsx    ← Slide-in panel — shows reverse edges when node selected
│
├── SymbolSearch.tsx             ← NEW — upgraded symbol search UI
│   ├── Props: { workspaceId: string; onSymbolSelect: (sym: SymbolSearchResult) => void }
│   ├── Data: GET /api/workspaces/:id/symbols?q=...&kind=...
│   └── Features: debounced input (300ms), kind filter dropdown, result list
│
└── IndexStatusBadge.tsx         ← NEW — shows idle/indexing/ready/error state
    ├── Props: { status: WorkspaceIndexStatus; onTrigger?: () => void }
    └── Used in: WorkspaceList row, WorkspaceDetail header
```

### 6.2 Modified Components

```
client/src/components/workspace/
├── WorkspaceDetail.tsx          ← ADD "Dependency Graph" tab (alongside existing tabs)
│   └── New tab panel: <DependencyGraph workspaceId={id} onNodeClick={navigateToFile} />
│
└── WorkspaceList.tsx            ← ADD <IndexStatusBadge> in each workspace row
```

### 6.3 New API Hooks

```
client/src/hooks/
├── useDependencyGraph.ts        ← useQuery for /dependency-graph endpoint
├── useSymbolSearch.ts           ← useQuery with debounced q param
├── useSymbolRefs.ts             ← useQuery for /symbols/:name/references
└── useIndexTrigger.ts           ← useMutation for POST /index
```

### 6.4 WS Hook Update

```
client/src/hooks/useWorkspaceSocket.ts  ← Handle new events:
  workspace:index_start       → set indexStatus = 'indexing', show progress bar
  workspace:index_progress    → update progress bar (filesProcessed/totalFiles)
  workspace:index_complete    → set indexStatus = 'ready', invalidate symbol queries
  workspace:index_error       → set indexStatus = 'error', show toast
```

### 6.5 DependencyGraph.tsx Sketch

```tsx
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from "reactflow";
import "reactflow/dist/style.css";

// Map API nodes/edges to ReactFlow format
// node.id = filePath
// node.data = { label: basename, importedByCount }
// edge.id = `${source}→${target}`
// Layout: use dagre for automatic hierarchical layout
//   (dagre is a dependency of reactflow ecosystem, safe to add)

// Click handler: onNodeClick → navigates to file in workspace editor
// Impact Radius: select node → highlight reverse edges in red
// Index status: show "Indexing..." overlay when indexStatus !== 'ready'
```

---

## 7. WebSocket Event Schema

All events broadcast via the existing `ws` WebSocket server using the pattern already established in the codebase. Events are scoped to a workspace ID via the `workspaceId` field.

### 7.1 `workspace:index_start`

Broadcast: when indexing begins (before first file is processed).

```typescript
interface WorkspaceIndexStartEvent {
  type: "workspace:index_start";
  workspaceId: string;
  totalFiles: number;       // estimated — file walk result before parsing begins
  triggeredAt: string;      // ISO 8601 timestamp
}
```

### 7.2 `workspace:index_progress`

Broadcast: after each batch of files is processed. Batches of 50 files.

```typescript
interface WorkspaceIndexProgressEvent {
  type: "workspace:index_progress";
  workspaceId: string;
  filesProcessed: number;   // cumulative files completed (parsed + skipped + errored)
  totalFiles: number;       // same value as in index_start
  symbolsFound: number;     // cumulative symbols extracted so far
  errorsCount: number;      // files that failed to parse
}
```

### 7.3 `workspace:index_complete`

Broadcast: when indexing finishes successfully.

```typescript
interface WorkspaceIndexCompleteEvent {
  type: "workspace:index_complete";
  workspaceId: string;
  symbolCount: number;      // total symbols now stored in DB for this workspace
  indexedFiles: number;     // files that were re-parsed (new or changed)
  skippedFiles: number;     // files with unchanged hash
  deletedFiles: number;     // symbols removed for deleted files
  errorsCount: number;      // files that failed to parse (non-fatal)
  durationMs: number;
}
```

### 7.4 `workspace:index_error` (bonus — for graceful UX)

Broadcast: if indexing fails fatally (e.g., workspace root inaccessible).

```typescript
interface WorkspaceIndexErrorEvent {
  type: "workspace:index_error";
  workspaceId: string;
  message: string;
}
```

---

## 8. Test Strategy

### 8.1 Unit Tests: WorkspaceIndexer

**File**: `server/workspace/indexer.test.ts`

Mock `@swc/core`:
```typescript
jest.mock("@swc/core", () => ({
  parseSync: jest.fn(),
}));
```

Test cases:
1. `indexFile` — parses a simple TS function, returns correct `ParsedSymbol` with name/kind/line/col
2. `indexFile` — parses a class with methods, extracts class symbol (not individual methods for MVP)
3. `indexFile` — parse error (SWC throws) → returns `{ error: "...", symbols: [], skipped: false }` without throwing
4. `indexFile` — path traversal attempt → throws "Path traversal attempt blocked"
5. `indexFile` — file > 1MB → skips gracefully
6. `hashFile` — returns consistent 64-char hex for known content
7. `indexWorkspace` — unchanged file (mock hash match) → file counted in `skippedFiles`
8. `indexWorkspace` — changed file (mock hash mismatch) → file re-parsed, symbols upserted
9. `indexWorkspace` — deleted file → `deletedFiles` count incremented, symbols removed from DB
10. `getSymbols` — case-insensitive prefix match works
11. `getSymbols` — `kind` filter returns only matching kinds
12. `getSymbols` — respects `limit` parameter

**DB**: Use a test Postgres instance (not mocked) or mock drizzle with `drizzle-orm/pg-core`'s in-memory adapter if available. Prefer real DB per project conventions.

### 8.2 Unit Tests: DependencyGraph

**File**: `server/workspace/dependency-graph.test.ts`

Test cases:
1. `buildGraph` — two files with one import → one edge, two nodes
2. `buildGraph` — circular import (A→B, B→A) → two edges, handles without infinite loop
3. `buildGraph` — bare module specifier (e.g. `"react"`) → excluded from graph (not an internal dep)
4. `buildGraph` — cached result returned on second call within TTL
5. `invalidateCache` — subsequent `buildGraph` call rebuilds from DB
6. `findReferences` — returns files that import the named symbol's defining file
7. `findReferences` — symbol not found → returns empty `files: []`
8. `findDefinition` — returns correct file/line/col/signature
9. `findDefinition` — symbol not in index → returns `null`

### 8.3 Integration Tests: API Endpoints

**File**: `server/routes/workspaces.index.test.ts`

Setup: real Express app + test DB + seeded workspace + pre-indexed symbols.

1. `GET /api/workspaces/:id/dependency-graph`
   - 200 with valid DependencyGraphResponse when workspace is `ready`
   - 401 when not authenticated
   - 403 when wrong user owns workspace
   - 404 when workspace ID doesn't exist
   - 409 when workspace `indexStatus === 'idle'`

2. `GET /api/workspaces/:id/symbols/:name/references`
   - 200 with RefResult array for known symbol
   - 200 with empty array for unknown symbol
   - 401/403/404 auth/ownership checks

3. `GET /api/workspaces/:id/symbols/:name/definition`
   - 200 with definition for known symbol
   - 200 with `definition: null` for unknown symbol
   - 401/403/404 checks

4. `GET /api/workspaces/:id/symbols?q=foo`
   - 200 with results when workspace indexed
   - 409 when not indexed
   - 400 when `q` missing
   - `kind` filter works correctly

5. `POST /api/workspaces/:id/index`
   - 202 and sets `indexStatus = 'indexing'`
   - 409 when already indexing
   - Verify WS event `workspace:index_start` is broadcast (spy on WS broadcast fn)

---

## 9. Security Checklist

### 9.1 Path Traversal Prevention

**Risk**: The indexer walks the filesystem. If `filePath` in DB or from a user query is manipulated, it could read outside the workspace root.

**Mitigation**:
- `WorkspaceIndexer.indexFile` uses `guardPath(workspaceRoot, filePath)` — identical to `WorkspaceManager.guardPath` — which resolves the absolute path and verifies it starts with `workspaceRoot + path.sep`.
- File discovery uses `fs.readdir` from the workspace root — no user-controlled path in file walker.
- `SKIP_DIRS` set prevents entering `node_modules`, `.git`, etc.
- `containsTraversal(rawPath)` check (from existing `code-search.ts` pattern) applied before any DB write of `filePath`.

### 9.2 Workspace Ownership Verification

**Risk**: User A could access workspace belonging to User B by guessing a UUID.

**Mitigation**:
- All 5 new endpoints use `getOwnedWorkspace(id, req.user!.id, res)` which checks `workspace.ownerId === userId`.
- `POST /api/workspaces` (existing) is updated to set `ownerId: req.user!.id` when creating a workspace.
- Pre-6.9 workspaces (null ownerId) remain accessible to all authenticated users for backward compatibility — documented limitation, addressed in a future security hardening phase.
- 403 response for ownership failures (not 404 — avoids workspace existence oracle).

### 9.3 PII Risks: Symbol Names from User Code

**Risk**: Symbol names, signatures, and file paths extracted from user code may contain PII (e.g., `processUserSocialSecurityNumber`, variable names with personal data).

**Mitigation**:
- Symbols are stored only in the DB row for the owning user's workspace — not shared globally.
- `workspace_symbols` has `ON DELETE CASCADE` on `workspace_id` — deleting a workspace purges all symbols.
- Symbol data is scoped to authenticated requests with ownership checks — not exposed publicly.
- Log files must NOT include symbol names at INFO level — only counts. Symbol names only at DEBUG level (disabled in production).
- Future consideration: allow workspace owners to mark workspaces as "no-index" if sensitive.

### 9.4 Injection in Symbol Search

**Risk**: The `q` query parameter is used in a DB `LIKE` / `ILIKE` query — potential for SQL injection via drizzle.

**Mitigation**:
- Use drizzle's parameterized query builders (`like`, `ilike`) — these use prepared statement parameter binding, not string interpolation.
- `q` validated by Zod: `z.string().min(1).max(256)` — bounded length prevents DoS via huge patterns.
- No raw SQL in symbol search path.

### 9.5 DoS via Large Repos

**Risk**: An attacker (or large repo) could trigger indexing of millions of files, consuming CPU/memory.

**Mitigation**:
- File walker respects `SKIP_DIRS` set (node_modules, .git, dist).
- `MAX_FILE_SIZE_BYTES = 1MB` per file — skip oversized files.
- Max 10,000 files per workspace index run (configurable `MAX_INDEX_FILES = 10_000`). Excess files logged, index completes with a warning.
- `POST /api/workspaces/:id/index` returns 409 if already indexing — prevents concurrent index storms.
- Rate limiting on index endpoint: max 1 manual trigger per workspace per 5 minutes (similar to sync throttle pattern already in the codebase).

### 9.6 SWC Parse Bomb

**Risk**: Specially crafted source files could cause `@swc/core` to consume excessive CPU.

**Mitigation**:
- Per-file parse timeout: wrap `parseSync` in a `Promise.race` with a 5-second timeout (using `AbortController` or a manual timer). On timeout, skip file and log warning.
- `MAX_FILE_SIZE_BYTES` check before parsing — reject files over 1MB.

---

## 10. Performance Targets

### Target: < 30 seconds for 10,000 files

**Assumptions**:
- Average file: 5 KB
- SWC parse speed: ~1,000 files/second (measured; SWC is written in Rust)
- DB batch upsert: 500 symbols per batch insert → ~2ms per batch

**Strategy**:

1. **Parallel file reads + hash computation**: Process files in concurrent batches of 50 using `Promise.all(batch.map(...))`. Node.js async I/O handles concurrency natively.
   - 10,000 files / 50 batch = 200 batches
   - ~5ms per batch (I/O bound) = ~1 second total for hash computation pass

2. **Incremental skip**: On re-index of unchanged repo, 99% of files skip after hash check. Hash check is DB query — covered by `workspace_symbols_file_idx` index. Batch hash lookups: fetch all `(filePath, fileHash)` for workspace in one query, build a `Map<filePath, hash>` for O(1) lookups per file.

3. **SWC parse rate**: 1,000 files/sec = 10 seconds for 10k files in single-threaded mode. With 50-concurrent batches: effectively parallelized via event loop (each parse is synchronous but I/O interleaved). Realistic parse time for 10k files: ~8-12 seconds.

4. **Batch DB inserts**: Collect all symbols per file, then batch-insert per workspace update. Use `INSERT ... ON CONFLICT DO UPDATE` with drizzle's `onConflictDoUpdate`. Batch size: 500 rows per insert. Estimated 10k files × avg 10 symbols = 100k symbols → 200 batches × 2ms = 400ms total DB write time.

5. **Total estimate**:
   - Hash comparison pass: ~1s
   - SWC parsing (assuming 30% files changed): 3,000 files × 1ms = 3s
   - Symbol extraction + batched DB writes: ~2s
   - **Total: ~6-8 seconds for first-index, ~1-2 seconds for incremental re-index**

6. **Memory**: Keep only current-batch symbols in memory. Clear after each batch write. Peak memory: 50 files × 1MB max = 50MB — well within typical Node.js heap.

### Stretch: Worker Threads

If 10k-file repos prove slow in production, move SWC parsing to a `worker_threads` pool (4 workers). Each worker handles a shard of files. Estimated 4x speedup: < 2 seconds first-index. Not needed for MVP.

---

## 11. Implementation Order

Recommended implementation sequence for the engineering phase:

1. **Migration** (`0003_phase_6_9_workspace_index.sql`) + schema additions to `shared/schema.ts`
2. **WorkspaceIndexer** (`server/workspace/indexer.ts`) + unit tests
3. **Auto-trigger on workspace create/sync** (update `server/routes/workspaces.ts`)
4. **Endpoint 5**: `POST /api/workspaces/:id/index` + WS broadcast helpers
5. **DependencyGraph** (`server/workspace/dependency-graph.ts`) + unit tests
6. **Endpoints 1-4** (dependency-graph + symbol search) + integration tests
7. **Frontend**: `IndexStatusBadge` → `SymbolSearch` → `DependencyGraph` component
8. **Upgrade `code-search.ts`**: `symbol` mode now queries `workspace_symbols` table
9. **E2E smoke test**: index a mid-size repo (500+ files), verify graph renders in UI

---

## Appendix A: File Inventory

| File | Action | Phase |
|------|--------|-------|
| `migrations/0003_phase_6_9_workspace_index.sql` | CREATE | 6.9.1 |
| `shared/schema.ts` | MODIFY — add `workspaceSymbols` table, `ownerId`/`indexStatus` to workspaces | 6.9.1 |
| `server/workspace/indexer.ts` | CREATE | 6.9.1 |
| `server/workspace/dependency-graph.ts` | CREATE | 6.9.2 |
| `server/tools/builtin/code-search.ts` | MODIFY — upgrade `symbol` mode | 6.9.3 |
| `server/routes/workspaces.ts` | MODIFY — add 5 endpoints + auto-index triggers | 6.9.1–6.9.5 |
| `client/src/components/workspace/DependencyGraph.tsx` | CREATE | 6.9.4 |
| `client/src/components/workspace/DGFileNode.tsx` | CREATE | 6.9.4 |
| `client/src/components/workspace/DGImpactPanel.tsx` | CREATE | 6.9.4 |
| `client/src/components/workspace/SymbolSearch.tsx` | CREATE | 6.9.3 |
| `client/src/components/workspace/IndexStatusBadge.tsx` | CREATE | 6.9.5 |
| `client/src/components/workspace/WorkspaceDetail.tsx` | MODIFY — add Dependency Graph tab | 6.9.4 |
| `client/src/components/workspace/WorkspaceList.tsx` | MODIFY — add IndexStatusBadge | 6.9.5 |
| `client/src/hooks/useDependencyGraph.ts` | CREATE | 6.9.4 |
| `client/src/hooks/useSymbolSearch.ts` | CREATE | 6.9.3 |
| `client/src/hooks/useSymbolRefs.ts` | CREATE | 6.9.2 |
| `client/src/hooks/useIndexTrigger.ts` | CREATE | 6.9.5 |
| `client/src/hooks/useWorkspaceSocket.ts` | MODIFY — handle index events | 6.9.5 |
| `server/workspace/indexer.test.ts` | CREATE | 6.9.1 |
| `server/workspace/dependency-graph.test.ts` | CREATE | 6.9.2 |
| `server/routes/workspaces.index.test.ts` | CREATE | all |

---

## Appendix B: New npm Dependency

**Add to `package.json`**:
```json
{
  "dependencies": {
    "@swc/core": "^1.10.0"
  }
}
```

Install: `npm install @swc/core`

`@swc/core` ships prebuilt binaries for Node 18+ on darwin-arm64, linux-x64, linux-arm64 via optional dependencies (`@swc/core-darwin-arm64`, etc.). No additional build tools required.
