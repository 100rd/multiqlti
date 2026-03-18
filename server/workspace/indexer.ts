/**
 * WorkspaceIndexer — Phase 6.9
 *
 * Walks a workspace filesystem, extracts symbols via @swc/core AST parsing
 * (in worker_threads to prevent parse bombs), and persists results to the
 * workspace_symbols table with incremental (hash-based) skipping.
 */
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { Worker } from "worker_threads";
import { db } from "../db.js";
import { workspaceSymbols } from "@shared/schema";
import { eq, and, inArray, sql as drizzleSql } from "drizzle-orm";
import type { WorkspaceRow, SymbolKind, WorkspaceSymbolRow } from "@shared/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__"]);
export const INDEXABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
export const MAX_FILE_SIZE_BYTES = 1_048_576; // 1 MB
export const MAX_INDEX_FILES = 10_000;
const WORKER_POOL_SIZE = 4;
const PARSE_TIMEOUT_MS = 5_000;
const BATCH_SIZE = 50;

// Worker script path — supports both ESM (import.meta.url) and CJS (__dirname)
const workerScriptPath =
  typeof __dirname !== "undefined"
    ? path.resolve(__dirname, "swc-worker.js")
    : fileURLToPath(new URL("./swc-worker.ts", import.meta.url));

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface IndexResult {
  workspaceId: string;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  deletedFiles: number;
  symbolCount: number;
  errors: IndexError[];
  durationMs: number;
}

export interface IndexError {
  filePath: string;
  message: string;
}

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

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  col: number;
  signature: string | null;
  exportedFrom: string | null;
}

export interface FileIndexResult {
  filePath: string;
  fileHash: string;
  symbols: ParsedSymbol[];
  skipped: boolean;
  error: string | null;
}

// ─── Worker Pool ──────────────────────────────────────────────────────────────

interface WorkerTask {
  resolve: (value: { result?: unknown; error?: string }) => void;
  reject: (err: Error) => void;
  source: string;
  isTypeScript: boolean;
  isTsx: boolean;
}

class WorkerPool {
  private queue: WorkerTask[] = [];
  private workers: Set<Worker> = new Set();
  private idle: Worker[] = [];
  private size: number;

  constructor(size: number) {
    this.size = size;
  }

  async parse(
    source: string,
    isTypeScript: boolean,
    isTsx: boolean,
  ): Promise<{ result?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, source, isTypeScript, isTsx });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0 && (this.idle.length > 0 || this.workers.size < this.size)) {
      const task = this.queue.shift()!;
      let worker: Worker;

      if (this.idle.length > 0) {
        // Reuse an idle worker — but workers run once and send a result; we need fresh workers
        // Workers terminate after each parse (by design), so pick from idle only if still alive.
        worker = this.idle.pop()!;
      } else {
        worker = this.createWorker(task);
        this.workers.add(worker);
        this.runTask(worker, task);
        return;
      }

      this.runTask(worker, task);
    }
  }

  private createWorker(task: WorkerTask): Worker {
    const execArgv = process.execArgv.length > 0 ? process.execArgv : undefined;
    const worker = new Worker(workerScriptPath, {
      workerData: {
        source: task.source,
        isTypeScript: task.isTypeScript,
        isTsx: task.isTsx,
      },
      execArgv,
    });
    return worker;
  }

  private runTask(worker: Worker, task: WorkerTask): void {
    // Ensure workerData is set for fresh workers (createWorker already sets it,
    // but for re-spawned fresh workers called via runTask directly, no separate start needed)

    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.workers.delete(worker);
      worker.terminate().catch(() => undefined);
      task.resolve({ error: "Parse timed out after 5 seconds" });
      this.dispatch();
    }, PARSE_TIMEOUT_MS);

    worker.once("message", (msg: { result?: unknown; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.workers.delete(worker);
      worker.terminate().catch(() => undefined);
      task.resolve(msg);
      this.dispatch();
    });

    worker.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.workers.delete(worker);
      task.resolve({ error: err.message });
      this.dispatch();
    });

    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.workers.delete(worker);
      if (code !== 0) {
        task.resolve({ error: `Worker exited with code ${code}` });
      }
      this.dispatch();
    });
  }

  terminate(): void {
    for (const w of this.workers) {
      w.terminate().catch(() => undefined);
    }
    this.workers.clear();
    this.idle = [];
    this.queue = [];
  }
}

// Module-level pool (shared across all indexer instances)
let sharedPool: WorkerPool | null = null;

function getWorkerPool(): WorkerPool {
  if (!sharedPool) {
    sharedPool = new WorkerPool(WORKER_POOL_SIZE);
  }
  return sharedPool;
}

// ─── SWC AST Types (minimal) ──────────────────────────────────────────────────

interface SwcSpan {
  start: number;
  end: number;
  ctxt: number;
}

interface SwcNode {
  type: string;
  span: SwcSpan;
}

interface SwcIdentifier extends SwcNode {
  type: "Identifier";
  value: string;
}

interface SwcBindingIdentifier extends SwcNode {
  type: "BindingIdentifier";
  value: string;
}

interface SwcStringLiteral extends SwcNode {
  type: "StringLiteral";
  value: string;
}

interface SwcFunctionDeclaration extends SwcNode {
  type: "FunctionDeclaration";
  identifier: SwcIdentifier;
  params: SwcNode[];
  returnType?: SwcNode & { typeAnnotation?: SwcNode & { type: string } };
  isAsync?: boolean;
  isGenerator?: boolean;
}

interface SwcClassDeclaration extends SwcNode {
  type: "ClassDeclaration";
  identifier: SwcIdentifier;
  superClass?: SwcIdentifier;
}

interface SwcTsInterfaceDeclaration extends SwcNode {
  type: "TsInterfaceDeclaration";
  id: SwcIdentifier;
}

interface SwcTsTypeAliasDeclaration extends SwcNode {
  type: "TsTypeAliasDeclaration";
  id: SwcIdentifier;
}

interface SwcVariableDeclarator extends SwcNode {
  id: SwcBindingIdentifier | SwcNode;
  typeAnnotation?: SwcNode;
}

interface SwcVariableDeclaration extends SwcNode {
  type: "VariableDeclaration";
  kind: "var" | "let" | "const";
  declarations: SwcVariableDeclarator[];
}

interface SwcImportDeclaration extends SwcNode {
  type: "ImportDeclaration";
  source: SwcStringLiteral;
  specifiers: SwcNode[];
}

interface SwcExportNamedDeclaration extends SwcNode {
  type: "ExportNamedDeclaration";
  declaration?: SwcNode;
  source?: SwcStringLiteral;
  specifiers?: Array<SwcNode & { orig?: SwcIdentifier; exported?: SwcIdentifier }>;
}

interface SwcExportDefaultDeclaration extends SwcNode {
  type: "ExportDefaultDeclaration";
  decl: SwcNode;
}

interface SwcExportDeclaration extends SwcNode {
  type: "ExportDeclaration";
  declaration: SwcNode;
}

interface SwcModule {
  type: "Module";
  body: SwcNode[];
}

// ─── Symbol Extraction ────────────────────────────────────────────────────────

function getLine(span: SwcSpan, source: string): number {
  // Count newlines before span.start to determine line number (1-indexed)
  const before = source.slice(0, span.start);
  return before.split("\n").length;
}

function getCol(span: SwcSpan, source: string): number {
  const before = source.slice(0, span.start);
  const lastNewline = before.lastIndexOf("\n");
  return lastNewline === -1 ? span.start : span.start - lastNewline - 1;
}

function extractSymbolsFromModule(module: SwcModule, source: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  for (const node of module.body) {
    extractFromNode(node, source, symbols, false);
  }

  return symbols;
}

function extractFromNode(
  node: SwcNode,
  source: string,
  symbols: ParsedSymbol[],
  isExported: boolean,
): void {
  switch (node.type) {
    case "ImportDeclaration": {
      const imp = node as SwcImportDeclaration;
      symbols.push({
        name: imp.source.value,
        kind: "import",
        line: getLine(imp.span, source),
        col: getCol(imp.span, source),
        signature: null,
        exportedFrom: imp.source.value,
      });
      break;
    }

    case "ExportDeclaration": {
      const expDecl = node as SwcExportDeclaration;
      extractFromNode(expDecl.declaration, source, symbols, true);
      break;
    }

    case "ExportDefaultDeclaration": {
      const expDefault = node as SwcExportDefaultDeclaration;
      extractFromNode(expDefault.decl, source, symbols, true);
      break;
    }

    case "ExportNamedDeclaration": {
      const expNamed = node as SwcExportNamedDeclaration;
      if (expNamed.declaration) {
        extractFromNode(expNamed.declaration, source, symbols, true);
      }
      if (expNamed.source) {
        // re-export from another module
        symbols.push({
          name: expNamed.source.value,
          kind: "export",
          line: getLine(expNamed.span, source),
          col: getCol(expNamed.span, source),
          signature: null,
          exportedFrom: expNamed.source.value,
        });
      }
      break;
    }

    case "FunctionDeclaration": {
      const fn = node as SwcFunctionDeclaration;
      const name = fn.identifier.value;
      const paramNames = fn.params
        .map((p) => {
          if (p.type === "Parameter") {
            const param = p as SwcNode & { pat?: SwcNode };
            if (param.pat && "value" in param.pat) {
              return (param.pat as SwcIdentifier).value;
            }
          }
          return "_";
        })
        .join(", ");
      const asyncPrefix = fn.isAsync ? "async " : "";
      symbols.push({
        name,
        kind: "function",
        line: getLine(fn.span, source),
        col: getCol(fn.span, source),
        signature: `${asyncPrefix}function ${name}(${paramNames})`,
        exportedFrom: isExported ? null : null,
      });
      break;
    }

    case "ClassDeclaration": {
      const cls = node as SwcClassDeclaration;
      const superClause = cls.superClass ? ` extends ${cls.superClass.value}` : "";
      symbols.push({
        name: cls.identifier.value,
        kind: "class",
        line: getLine(cls.span, source),
        col: getCol(cls.span, source),
        signature: `class ${cls.identifier.value}${superClause}`,
        exportedFrom: null,
      });
      break;
    }

    case "TsInterfaceDeclaration": {
      const iface = node as SwcTsInterfaceDeclaration;
      symbols.push({
        name: iface.id.value,
        kind: "interface",
        line: getLine(iface.span, source),
        col: getCol(iface.span, source),
        signature: `interface ${iface.id.value}`,
        exportedFrom: null,
      });
      break;
    }

    case "TsTypeAliasDeclaration": {
      const typeAlias = node as SwcTsTypeAliasDeclaration;
      symbols.push({
        name: typeAlias.id.value,
        kind: "type",
        line: getLine(typeAlias.span, source),
        col: getCol(typeAlias.span, source),
        signature: `type ${typeAlias.id.value}`,
        exportedFrom: null,
      });
      break;
    }

    case "VariableDeclaration": {
      const varDecl = node as SwcVariableDeclaration;
      for (const declarator of varDecl.declarations) {
        if (declarator.id && "value" in declarator.id) {
          const ident = declarator.id as SwcBindingIdentifier;
          symbols.push({
            name: ident.value,
            kind: "variable",
            line: getLine(varDecl.span, source),
            col: getCol(varDecl.span, source),
            signature: `${varDecl.kind} ${ident.value}`,
            exportedFrom: null,
          });
        }
      }
      break;
    }
  }
}

// ─── Path Security ────────────────────────────────────────────────────────────

function guardPath(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    throw new Error("Path traversal attempt blocked");
  }
  return resolved;
}

function resolveWorkspaceRoot(workspace: WorkspaceRow): string {
  if (workspace.type === "local") return workspace.path;
  return path.join("data/workspaces", workspace.id);
}

// ─── WorkspaceIndexer Class ───────────────────────────────────────────────────

type BroadcastFn = (workspaceId: string, event: string, payload: Record<string, unknown>) => void;

export class WorkspaceIndexer {
  private broadcast: BroadcastFn;
  private pool: WorkerPool;

  constructor(broadcast?: BroadcastFn, pool?: WorkerPool) {
    this.broadcast = broadcast ?? (() => undefined);
    this.pool = pool ?? getWorkerPool();
  }

  /**
   * Index all indexable files in a workspace.
   */
  async indexWorkspace(workspace: WorkspaceRow): Promise<IndexResult> {
    const startMs = Date.now();
    const workspaceRoot = resolveWorkspaceRoot(workspace);

    // Collect all indexable files
    const allFiles = await this.collectIndexableFiles(workspaceRoot);
    const totalFiles = allFiles.length;

    this.broadcast(workspace.id, "workspace:index_start", {
      workspaceId: workspace.id,
      totalFiles,
      triggeredAt: new Date().toISOString(),
    });

    // Fetch existing hash map from DB in one query
    const existingRows = await db
      .select({ filePath: workspaceSymbols.filePath, fileHash: workspaceSymbols.fileHash })
      .from(workspaceSymbols)
      .where(eq(workspaceSymbols.workspaceId, workspace.id));

    const hashMap = new Map<string, string>();
    for (const row of existingRows) {
      hashMap.set(row.filePath, row.fileHash);
    }

    // Process files in batches
    const errors: IndexError[] = [];
    let indexedFiles = 0;
    let skippedFiles = 0;
    let symbolsFound = 0;

    // Limit files
    const filesToProcess = allFiles.slice(0, MAX_INDEX_FILES);
    if (allFiles.length > MAX_INDEX_FILES) {
      errors.push({
        filePath: "<workspace>",
        message: `Workspace exceeds MAX_INDEX_FILES (${MAX_INDEX_FILES}). Indexing first ${MAX_INDEX_FILES} files only.`,
      });
    }

    // Track which relative paths are on disk
    const currentRelPaths = new Set<string>();

    for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
      const batch = filesToProcess.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map((absPath) => {
          const relPath = path.relative(workspaceRoot, absPath);
          currentRelPaths.add(relPath);
          return this.processFile(workspace, workspaceRoot, absPath, relPath, hashMap);
        }),
      );

      for (const result of batchResults) {
        if (result.skipped) {
          skippedFiles++;
        } else if (result.error) {
          errors.push({ filePath: result.filePath, message: result.error });
        } else {
          indexedFiles++;
          symbolsFound += result.symbols.length;
        }
      }

      // Broadcast progress every batch
      this.broadcast(workspace.id, "workspace:index_progress", {
        workspaceId: workspace.id,
        filesProcessed: Math.min(i + BATCH_SIZE, filesToProcess.length),
        totalFiles,
        symbolsFound,
        errorsCount: errors.length,
      });
    }

    // Delete symbols for stale files (files no longer in workspace)
    const deletedFiles = await this.deleteStaleSymbols(workspace.id, currentRelPaths);

    // Count total symbols now stored
    const [countRow] = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(workspaceSymbols)
      .where(eq(workspaceSymbols.workspaceId, workspace.id));

    const symbolCount = countRow?.count ?? 0;
    const durationMs = Date.now() - startMs;

    this.broadcast(workspace.id, "workspace:index_complete", {
      workspaceId: workspace.id,
      symbolCount,
      indexedFiles,
      skippedFiles,
      deletedFiles,
      errorsCount: errors.length,
      durationMs,
    });

    return {
      workspaceId: workspace.id,
      totalFiles,
      indexedFiles,
      skippedFiles,
      deletedFiles,
      symbolCount,
      errors,
      durationMs,
    };
  }

  /**
   * Index a single file within a workspace.
   * Security: uses guardPath — resolved path must stay within workspace root.
   * Graceful on parse error: returns empty symbols + error string, does NOT throw.
   */
  async indexFile(workspace: WorkspaceRow, filePath: string): Promise<FileIndexResult> {
    const workspaceRoot = resolveWorkspaceRoot(workspace);

    let absolutePath: string;
    try {
      absolutePath = guardPath(workspaceRoot, filePath);
    } catch {
      throw new Error("Path traversal attempt blocked");
    }

    const relPath = path.relative(workspaceRoot, absolutePath);

    // Check file size
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      return { filePath: relPath, fileHash: "", symbols: [], skipped: false, error: "File not found" };
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) {
      return {
        filePath: relPath,
        fileHash: "",
        symbols: [],
        skipped: false,
        error: `File exceeds ${MAX_FILE_SIZE_BYTES} byte limit`,
      };
    }

    const fileHash = await this.hashFile(absolutePath);

    // Read source
    let source: string;
    try {
      source = await fs.readFile(absolutePath, "utf-8");
    } catch (err) {
      return {
        filePath: relPath,
        fileHash,
        symbols: [],
        skipped: false,
        error: `Failed to read file: ${(err as Error).message}`,
      };
    }

    // Parse via worker pool
    const ext = path.extname(absolutePath).toLowerCase();
    const isTypeScript = ext === ".ts" || ext === ".tsx";
    const isTsx = ext === ".tsx" || ext === ".jsx";

    const parseResult = await this.pool.parse(source, isTypeScript, isTsx);

    if (parseResult.error) {
      return { filePath: relPath, fileHash, symbols: [], skipped: false, error: parseResult.error };
    }

    let symbols: ParsedSymbol[] = [];
    try {
      symbols = extractSymbolsFromModule(parseResult.result as SwcModule, source);
    } catch (err) {
      return {
        filePath: relPath,
        fileHash,
        symbols: [],
        skipped: false,
        error: `Symbol extraction failed: ${(err as Error).message}`,
      };
    }

    // Upsert symbols to DB
    if (symbols.length > 0) {
      await this.upsertSymbols(workspace.id, relPath, fileHash, symbols);
    } else {
      // Delete any existing symbols for this file (file now has no symbols)
      await db
        .delete(workspaceSymbols)
        .where(
          and(
            eq(workspaceSymbols.workspaceId, workspace.id),
            eq(workspaceSymbols.filePath, relPath),
          ),
        );
    }

    return { filePath: relPath, fileHash, symbols, skipped: false, error: null };
  }

  /**
   * Query symbols from DB for a workspace.
   */
  async getSymbols(
    workspaceId: string,
    query: string,
    kind?: SymbolKind,
    limit = 50,
  ): Promise<SymbolSearchResult[]> {
    const effectiveLimit = Math.min(limit, 200);
    const lowerQuery = query.toLowerCase();

    const allSymbols = await db
      .select()
      .from(workspaceSymbols)
      .where(eq(workspaceSymbols.workspaceId, workspaceId));

    const filtered = allSymbols
      .filter((s) => {
        const nameMatch = s.name.toLowerCase().includes(lowerQuery);
        const kindMatch = kind === undefined || s.kind === kind;
        return nameMatch && kindMatch;
      })
      .slice(0, effectiveLimit);

    return filtered.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      filePath: s.filePath,
      name: s.name,
      kind: s.kind as SymbolKind,
      line: s.line,
      col: s.col,
      signature: s.signature,
      fileHash: s.fileHash,
      exportedFrom: s.exportedFrom,
    }));
  }

  /**
   * Return SHA-256 hex of a file's raw buffer.
   */
  async hashFile(absolutePath: string): Promise<string> {
    const buf = await fs.readFile(absolutePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  /**
   * List all file paths currently indexed for a workspace.
   */
  async listIndexedFiles(workspaceId: string): Promise<string[]> {
    const rows = await db
      .selectDistinct({ filePath: workspaceSymbols.filePath })
      .from(workspaceSymbols)
      .where(eq(workspaceSymbols.workspaceId, workspaceId));
    return rows.map((r) => r.filePath);
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private async collectIndexableFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    await this.walkDir(root, root, results);
    return results;
  }

  private async walkDir(root: string, dir: string, results: string[]): Promise<void> {
    if (results.length >= MAX_INDEX_FILES) return;

    let entries: import("fs").Dirent<string>[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_INDEX_FILES) break;

      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.walkDir(root, full, results);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (INDEXABLE_EXTENSIONS.has(ext)) {
          results.push(full);
        }
      }
    }
  }

  private async processFile(
    workspace: WorkspaceRow,
    workspaceRoot: string,
    absolutePath: string,
    relPath: string,
    hashMap: Map<string, string>,
  ): Promise<FileIndexResult> {
    try {
      // Check file size
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absolutePath);
      } catch {
        return { filePath: relPath, fileHash: "", symbols: [], skipped: false, error: "File not accessible" };
      }

      if (stat.size > MAX_FILE_SIZE_BYTES) {
        return { filePath: relPath, fileHash: "", symbols: [], skipped: false, error: "File too large" };
      }

      const currentHash = await this.hashFile(absolutePath);
      const storedHash = hashMap.get(relPath);

      if (storedHash === currentHash) {
        return { filePath: relPath, fileHash: currentHash, symbols: [], skipped: true, error: null };
      }

      // File changed or new — index it
      const result = await this.indexFile(workspace, relPath);
      return result;
    } catch (err) {
      return {
        filePath: relPath,
        fileHash: "",
        symbols: [],
        skipped: false,
        error: (err as Error).message,
      };
    }
  }

  private async upsertSymbols(
    workspaceId: string,
    filePath: string,
    fileHash: string,
    symbols: ParsedSymbol[],
  ): Promise<void> {
    // Delete existing symbols for this file first, then insert new ones
    // (simpler than ON CONFLICT UPDATE for changing symbol sets)
    await db
      .delete(workspaceSymbols)
      .where(
        and(
          eq(workspaceSymbols.workspaceId, workspaceId),
          eq(workspaceSymbols.filePath, filePath),
        ),
      );

    const rows = symbols.map((sym) => ({
      workspaceId,
      filePath,
      name: sym.name,
      kind: sym.kind,
      line: sym.line,
      col: sym.col,
      signature: sym.signature,
      fileHash,
      exportedFrom: sym.exportedFrom,
    }));

    if (rows.length === 0) return;

    // Insert in batches of 500
    const INSERT_BATCH = 500;
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const batch = rows.slice(i, i + INSERT_BATCH);
      await db
        .insert(workspaceSymbols)
        .values(batch)
        .onConflictDoUpdate({
          target: [
            workspaceSymbols.workspaceId,
            workspaceSymbols.filePath,
            workspaceSymbols.name,
            workspaceSymbols.kind,
          ],
          set: {
            line: drizzleSql`excluded.line`,
            col: drizzleSql`excluded.col`,
            signature: drizzleSql`excluded.signature`,
            fileHash: drizzleSql`excluded.file_hash`,
            exportedFrom: drizzleSql`excluded.exported_from`,
            updatedAt: drizzleSql`NOW()`,
          },
        });
    }
  }

  private async deleteStaleSymbols(
    workspaceId: string,
    currentRelPaths: Set<string>,
  ): Promise<number> {
    // Get all indexed file paths for this workspace
    const indexedPaths = await this.listIndexedFiles(workspaceId);
    const stalePaths = indexedPaths.filter((p) => !currentRelPaths.has(p));

    if (stalePaths.length === 0) return 0;

    // Delete in batches to avoid large IN clauses
    const DELETE_BATCH = 500;
    for (let i = 0; i < stalePaths.length; i += DELETE_BATCH) {
      const batch = stalePaths.slice(i, i + DELETE_BATCH);
      await db
        .delete(workspaceSymbols)
        .where(
          and(
            eq(workspaceSymbols.workspaceId, workspaceId),
            inArray(workspaceSymbols.filePath, batch),
          ),
        );
    }

    return stalePaths.length;
  }
}
