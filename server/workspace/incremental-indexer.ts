/**
 * IncrementalIndexer — Issue #284
 *
 * Orchestrates file-watch-driven incremental indexing:
 *   1. On workspace activation, starts the FileWatcher.
 *   2. On each debounced flush, computes which files changed/were deleted.
 *   3. For changed files: re-parses only if the content hash changed.
 *   4. For deleted/renamed files: removes nodes + edges from the graph.
 *   5. Produces a minimal patch and persists it to the WAL.
 *   6. Exposes a triggerFullRebuild() method for manual/scheduled use.
 *
 * Thread safety: all operations are serialised via a single async queue.
 * This means concurrent flush calls are queued, not dropped.
 */
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import type { WorkspaceRow } from "@shared/schema";
import { WorkspaceIndexer, INDEXABLE_EXTENSIONS, SKIP_DIRS } from "./indexer.js";
import { FileWatcher, type WatchEvent, type FileWatcherOptions } from "./file-watcher.js";
import { PatchableGraph, type GraphEdge, type GraphNode } from "./patchable-graph.js";
import { IndexSnapshot } from "./index-snapshot.js";
import { IndexerMetrics } from "./indexer-metrics.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Directory (relative to workspace root) where snapshot/WAL files are stored. */
const SNAPSHOT_SUBDIR = ".multiqlti-index";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface IncrementalIndexerOptions {
  /** Debounce window in ms (passed to FileWatcher). Default: 300. */
  debounceMs?: number;
  /** Extra gitignore-style patterns to ignore. */
  extraIgnorePatterns?: string[];
  /** Data directory for snapshot/WAL files. Default: <workspaceRoot>/.multiqlti-index */
  dataDir?: string;
}

export interface IncrementalFlushResult {
  workspaceId: string;
  reparsed: number;
  skipped: number;
  removed: number;
  patchOps: number;
  errors: string[];
  durationMs: number;
}

type BroadcastFn = (workspaceId: string, event: string, payload: Record<string, unknown>) => void;

// ─── Async Queue ──────────────────────────────────────────────────────────────

/**
 * Minimal serial async queue — ensures only one operation runs at a time.
 */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep tail alive even if the task rejects
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ─── IncrementalIndexer ───────────────────────────────────────────────────────

export class IncrementalIndexer {
  private readonly workspace: WorkspaceRow;
  private readonly workspaceRoot: string;
  private readonly indexer: WorkspaceIndexer;
  private readonly broadcast: BroadcastFn;
  private readonly options: Required<IncrementalIndexerOptions>;

  /** Per-file content hash cache: relPath → sha256 hex */
  private hashCache: Map<string, string> = new Map();

  /** The live patchable graph for this workspace. */
  readonly graph: PatchableGraph;

  /** Snapshot + WAL persistence. */
  private readonly snapshot: IndexSnapshot;

  /** Metrics collector. */
  readonly metrics: IndexerMetrics;

  private watcher: FileWatcher | null = null;
  private readonly queue: SerialQueue = new SerialQueue();
  private active = false;

  constructor(
    workspace: WorkspaceRow,
    workspaceRoot: string,
    broadcast: BroadcastFn,
    options: IncrementalIndexerOptions = {},
    indexer?: WorkspaceIndexer,
  ) {
    this.workspace = workspace;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.broadcast = broadcast;
    this.options = {
      debounceMs: options.debounceMs ?? 300,
      extraIgnorePatterns: options.extraIgnorePatterns ?? [],
      dataDir: options.dataDir ?? path.join(this.workspaceRoot, SNAPSHOT_SUBDIR),
    };

    this.indexer = indexer ?? new WorkspaceIndexer(broadcast);
    this.graph = new PatchableGraph();
    this.snapshot = new IndexSnapshot(this.options.dataDir, workspace.id);
    this.metrics = new IndexerMetrics();
  }

  /**
   * Activate incremental indexing for this workspace.
   * Tries to restore the graph from the snapshot first; if no snapshot exists
   * the graph starts empty (a full rebuild should be triggered separately).
   */
  async activate(): Promise<void> {
    if (this.active) return;
    this.active = true;

    // Restore from snapshot + WAL if available
    const loaded = await this.snapshot.load();
    if (loaded.fromCache) {
      this.graph.restore(loaded.graph.snapshot());
    }

    // Start the file watcher
    const watcherOptions: FileWatcherOptions = {
      debounceMs: this.options.debounceMs,
      extraIgnorePatterns: this.options.extraIgnorePatterns,
    };

    this.watcher = new FileWatcher(
      this.workspaceRoot,
      (events) => this.queue.enqueue(() => this.handleFlush(events)),
      watcherOptions,
    );

    await this.watcher.start();
  }

  /**
   * Deactivate incremental indexing.
   * Stops the watcher; outstanding queued operations will complete first.
   */
  async deactivate(): Promise<void> {
    if (!this.active) return;
    this.active = false;

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }

  /** True if the indexer is actively watching. */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Trigger a full rebuild of the entire workspace.
   * Clears the hash cache, snapshot, and WAL, then re-indexes every file.
   */
  async triggerFullRebuild(): Promise<void> {
    this.metrics.recordFullRebuild();
    return this.queue.enqueue(() => this.doFullRebuild());
  }

  // ─── Internal: Incremental flush ─────────────────────────────────────────────

  private async handleFlush(events: WatchEvent[]): Promise<void> {
    // Record events in metrics
    for (const _ of events) {
      this.metrics.recordEvent();
    }

    const startMs = Date.now();
    const errors: string[] = [];
    let reparsed = 0;
    let skipped = 0;
    let removed = 0;

    for (const event of events) {
      try {
        if (event.kind === "unlink") {
          // File was deleted
          this.removeFileFromGraph(event.relativePath);
          this.hashCache.delete(event.relativePath);
          removed++;
        } else {
          // "add" or "change"
          const ext = path.extname(event.absolutePath).toLowerCase();
          if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

          const parseStart = Date.now();
          const result = await this.processFile(event.absolutePath, event.relativePath);
          const parseDuration = Date.now() - parseStart;

          if (result.kind === "skipped") {
            skipped++;
          } else if (result.kind === "reparsed") {
            reparsed++;
            this.metrics.recordReparseDuration(parseDuration);
            this.updateFileInGraph(event.relativePath, result.imports);
          } else if (result.kind === "error") {
            errors.push(`${event.relativePath}: ${result.error}`);
          }
        }
      } catch (err) {
        errors.push(`${event.relativePath}: ${(err as Error).message}`);
      }
    }

    // Flush patch and persist to WAL
    const ops = this.graph.flushPatch();
    if (ops.length > 0) {
      this.metrics.recordPatchSize(ops.length);
      await this.snapshot.appendWal(ops).catch(() => undefined);
    }

    const durationMs = Date.now() - startMs;

    const result: IncrementalFlushResult = {
      workspaceId: this.workspace.id,
      reparsed,
      skipped,
      removed,
      patchOps: ops.length,
      errors,
      durationMs,
    };

    this.broadcast(this.workspace.id, "workspace:incremental_flush", {
      ...result,
    });
  }

  // ─── Internal: Full rebuild ───────────────────────────────────────────────────

  private async doFullRebuild(): Promise<void> {
    // Clear existing state
    this.hashCache.clear();
    await this.snapshot.clear();

    // Run a full index via the existing WorkspaceIndexer
    await this.indexer.indexWorkspace(this.workspace);

    // Rebuild in-memory graph from symbols in DB
    await this.rebuildGraphFromDb();

    // Write a fresh checkpoint
    await this.snapshot.checkpoint(this.graph);

    this.broadcast(this.workspace.id, "workspace:full_rebuild_complete", {
      workspaceId: this.workspace.id,
      nodeCount: this.graph.nodeCount(),
      edgeCount: this.graph.edgeCount(),
    });
  }

  /**
   * Rebuilds the in-memory PatchableGraph from the DB workspace_symbols data.
   * Called after full rebuild and on first activation when no snapshot exists.
   */
  private async rebuildGraphFromDb(): Promise<void> {
    // Fetch all symbols with kind="import" from the indexer
    const rawSymbols = await this.indexer.getSymbols(this.workspace.id, "", undefined, 200);

    const newGraph = new PatchableGraph();
    const nodeSet = new Set<string>();
    const importCountMap = new Map<string, number>();
    const importedByCountMap = new Map<string, number>();
    const edges: GraphEdge[] = [];

    for (const sym of rawSymbols) {
      if (sym.kind !== "import") continue;
      const specifier = sym.name;
      if (!specifier.startsWith(".")) continue;

      const sourceFile = sym.filePath;
      const sourceDir = path.dirname(sourceFile);
      let target = path.normalize(path.join(sourceDir, specifier));
      target = target.replace(/\\/g, "/");
      if (!/\.[a-zA-Z]+$/.test(target)) target = `${target}.ts`;

      nodeSet.add(sourceFile);
      nodeSet.add(target);

      const edgeId = `${sourceFile}→${target}`;
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({ id: edgeId, source: sourceFile, target });
        importCountMap.set(sourceFile, (importCountMap.get(sourceFile) ?? 0) + 1);
        importedByCountMap.set(target, (importedByCountMap.get(target) ?? 0) + 1);
      }
    }

    for (const nodeId of nodeSet) {
      const node: GraphNode = {
        id: nodeId,
        label: path.basename(nodeId),
        importCount: importCountMap.get(nodeId) ?? 0,
        importedByCount: importedByCountMap.get(nodeId) ?? 0,
      };
      newGraph.addNode(node);
    }

    for (const edge of edges) {
      newGraph.addEdge(edge);
    }

    // Replace the current graph state with the new one
    const snap = newGraph.snapshot();
    this.graph.restore(snap);
  }

  // ─── Internal: File-level operations ─────────────────────────────────────────

  private async processFile(
    absolutePath: string,
    relPath: string,
  ): Promise<
    | { kind: "skipped" }
    | { kind: "reparsed"; imports: string[] }
    | { kind: "error"; error: string }
  > {
    // Check if content hash changed
    let currentHash: string;
    try {
      const buf = await fs.readFile(absolutePath);
      currentHash = crypto.createHash("sha256").update(buf).digest("hex");
    } catch {
      return { kind: "error", error: "File not readable" };
    }

    const cachedHash = this.hashCache.get(relPath);
    if (cachedHash === currentHash) {
      return { kind: "skipped" };
    }

    // Hash changed — re-parse
    this.hashCache.set(relPath, currentHash);

    const fileResult = await this.indexer.indexFile(this.workspace, relPath);
    if (fileResult.error) {
      return { kind: "error", error: fileResult.error };
    }

    // Extract import specifiers from symbols
    const imports = fileResult.symbols
      .filter((s) => s.kind === "import" && s.exportedFrom != null)
      .map((s) => s.exportedFrom as string);

    return { kind: "reparsed", imports };
  }

  /**
   * Update graph edges for a file based on its new import list.
   * Removes old edges for this source file, then adds new ones.
   */
  private updateFileInGraph(relPath: string, imports: string[]): void {
    // Ensure the node exists
    if (!this.graph.hasNode(relPath)) {
      this.graph.addNode({
        id: relPath,
        label: path.basename(relPath),
        importCount: 0,
        importedByCount: 0,
      });
    }

    // Remove all existing outgoing edges from this file
    const existingEdges = this.graph.allEdges().filter((e) => e.source === relPath);
    for (const edge of existingEdges) {
      this.graph.removeEdge(edge.id);
    }

    // Add new edges
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) continue;

      const sourceDir = path.dirname(relPath);
      let target = path.normalize(path.join(sourceDir, specifier));
      target = target.replace(/\\/g, "/");
      if (!/\.[a-zA-Z]+$/.test(target)) target = `${target}.ts`;

      const edgeId = `${relPath}→${target}`;

      // Ensure target node exists as a placeholder
      if (!this.graph.hasNode(target)) {
        this.graph.addNode({
          id: target,
          label: path.basename(target),
          importCount: 0,
          importedByCount: 0,
        });
      }

      if (!this.graph.hasEdge(edgeId)) {
        this.graph.addEdge({ id: edgeId, source: relPath, target });
      }
    }
  }

  /**
   * Remove a file node and all its edges from the graph.
   */
  private removeFileFromGraph(relPath: string): void {
    this.graph.removeNode(relPath);
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Module-level registry mapping workspaceId → IncrementalIndexer.
 * Used to start/stop watchers on workspace lifecycle events.
 */
const registry = new Map<string, IncrementalIndexer>();

export function getOrCreateIncrementalIndexer(
  workspace: WorkspaceRow,
  workspaceRoot: string,
  broadcast: BroadcastFn,
  options?: IncrementalIndexerOptions,
  indexer?: WorkspaceIndexer,
): IncrementalIndexer {
  let inc = registry.get(workspace.id);
  if (!inc) {
    inc = new IncrementalIndexer(workspace, workspaceRoot, broadcast, options, indexer);
    registry.set(workspace.id, inc);
  }
  return inc;
}

export function getIncrementalIndexer(workspaceId: string): IncrementalIndexer | undefined {
  return registry.get(workspaceId);
}

export async function removeIncrementalIndexer(workspaceId: string): Promise<void> {
  const inc = registry.get(workspaceId);
  if (inc) {
    await inc.deactivate();
    registry.delete(workspaceId);
  }
}
