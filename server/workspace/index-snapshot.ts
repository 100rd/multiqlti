/**
 * IndexSnapshot — Issue #284
 *
 * Persists graph state using a snapshot + WAL (write-ahead log) strategy so
 * that server restarts do not require a full reindex.
 *
 * Layout (all files under `dataDir`):
 *   graph-snapshot.json   — full snapshot at checkpoint time
 *   graph-wal.jsonl       — newline-delimited JSON of PatchOp[] entries
 *
 * On startup, load() reads the snapshot then replays all WAL entries.
 * On save(), the current patch is appended to the WAL.
 * checkpoint() compacts: writes a new snapshot and truncates the WAL.
 */
import path from "path";
import fs from "fs/promises";
import { PatchableGraph, type PatchOp, type GraphSnapshot } from "./patchable-graph.js";

// ─── Constants ────────────────────────────────────────────────────────────────

export const SNAPSHOT_FILENAME = "graph-snapshot.json";
export const WAL_FILENAME = "graph-wal.jsonl";

/** Serialization version. Increment when the file format changes. */
export const SERIALIZATION_VERSION = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SnapshotFile {
  serializationVersion: number;
  workspaceId: string;
  graph: GraphSnapshot;
}

export interface WalEntry {
  ops: PatchOp[];
  flushedAt: string; // ISO timestamp
}

export interface LoadResult {
  graph: PatchableGraph;
  /** True if snapshot was found and loaded; false if a fresh graph was returned. */
  fromCache: boolean;
  walEntriesReplayed: number;
}

// ─── IndexSnapshot Class ──────────────────────────────────────────────────────

export class IndexSnapshot {
  private readonly dataDir: string;
  private readonly workspaceId: string;

  constructor(dataDir: string, workspaceId: string) {
    this.dataDir = path.resolve(dataDir);
    this.workspaceId = workspaceId;
  }

  private get snapshotPath(): string {
    return path.join(this.dataDir, SNAPSHOT_FILENAME);
  }

  private get walPath(): string {
    return path.join(this.dataDir, WAL_FILENAME);
  }

  /**
   * Ensure the data directory exists.
   */
  async ensureDir(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  /**
   * Load the graph from disk (snapshot + WAL replay).
   * Returns a fresh empty graph if no snapshot file is found.
   */
  async load(): Promise<LoadResult> {
    await this.ensureDir();

    const graph = new PatchableGraph();

    // Try to read the snapshot
    let fromCache = false;
    try {
      const raw = await fs.readFile(this.snapshotPath, "utf-8");
      const file = JSON.parse(raw) as SnapshotFile;

      if (
        file.serializationVersion !== SERIALIZATION_VERSION ||
        file.workspaceId !== this.workspaceId
      ) {
        // Version mismatch or workspace mismatch — start fresh
        return { graph, fromCache: false, walEntriesReplayed: 0 };
      }

      graph.restore(file.graph);
      fromCache = true;
    } catch {
      // Snapshot absent or corrupt — fresh graph
      return { graph, fromCache: false, walEntriesReplayed: 0 };
    }

    // Replay WAL
    let walEntriesReplayed = 0;
    try {
      const walRaw = await fs.readFile(this.walPath, "utf-8");
      const lines = walRaw.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as WalEntry;
          for (const op of entry.ops) {
            graph.applyOp(op);
          }
          walEntriesReplayed++;
        } catch {
          // Malformed WAL line — skip
        }
      }
    } catch {
      // WAL absent — fine
    }

    return { graph, fromCache, walEntriesReplayed };
  }

  /**
   * Append a batch of patch operations to the WAL file.
   * Creates the file if it does not exist.
   */
  async appendWal(ops: PatchOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.ensureDir();

    const entry: WalEntry = {
      ops,
      flushedAt: new Date().toISOString(),
    };
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(this.walPath, line, "utf-8");
  }

  /**
   * Write the current graph state as a new snapshot and truncate the WAL.
   * This is the "checkpoint" operation — called after a full rebuild or
   * periodically to bound recovery time.
   */
  async checkpoint(graph: PatchableGraph): Promise<void> {
    await this.ensureDir();

    const snapshotFile: SnapshotFile = {
      serializationVersion: SERIALIZATION_VERSION,
      workspaceId: this.workspaceId,
      graph: graph.snapshot(),
    };

    // Write snapshot atomically using a temp file + rename
    const tmpPath = this.snapshotPath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(snapshotFile, null, 2), "utf-8");
    await fs.rename(tmpPath, this.snapshotPath);

    // Truncate WAL
    await fs.writeFile(this.walPath, "", "utf-8");
  }

  /**
   * Delete all persisted files for this workspace (used on full rebuild trigger).
   */
  async clear(): Promise<void> {
    await Promise.allSettled([
      fs.unlink(this.snapshotPath),
      fs.unlink(this.walPath),
    ]);
  }

  /**
   * Return true if a snapshot file exists for this workspace.
   */
  async hasSnapshot(): Promise<boolean> {
    try {
      await fs.access(this.snapshotPath);
      return true;
    } catch {
      return false;
    }
  }
}
