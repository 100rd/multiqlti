/**
 * FileWatcher — Issue #284
 *
 * Chokidar-based file watcher for incremental workspace indexing.
 * Debounces bursts of filesystem events into a single reindex pass.
 * Respects .gitignore and workspace-specific ignore patterns.
 */
import path from "path";
import fs from "fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import { SKIP_DIRS, INDEXABLE_EXTENSIONS } from "./indexer.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default debounce window in milliseconds. */
export const DEFAULT_DEBOUNCE_MS = 300;

/** Maximum number of paths to queue before flushing immediately. */
export const MAX_QUEUE_SIZE = 500;

// ─── Public Types ─────────────────────────────────────────────────────────────

export type WatchEventKind = "add" | "change" | "unlink";

export interface WatchEvent {
  kind: WatchEventKind;
  absolutePath: string;
  relativePath: string;
}

export interface FileWatcherOptions {
  /** Debounce window in ms. Default: 300. */
  debounceMs?: number;
  /** Extra gitignore-style patterns to ignore (in addition to .gitignore). */
  extraIgnorePatterns?: string[];
}

export type WatchFlushCallback = (events: WatchEvent[]) => void | Promise<void>;

// ─── Gitignore Parser ─────────────────────────────────────────────────────────

/**
 * Reads .gitignore in the given root directory and returns a list of
 * patterns suitable for passing to chokidar as `ignored`.
 *
 * Returns an empty array if .gitignore does not exist or cannot be read.
 */
export async function readGitignorePatterns(root: string): Promise<string[]> {
  const gitignorePath = path.join(root, ".gitignore");
  let content: string;
  try {
    content = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    return [];
  }

  const patterns: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

/**
 * Build the set of chokidar `ignored` options from:
 * - SKIP_DIRS (node_modules, .git, etc.)
 * - .gitignore patterns
 * - Extra patterns supplied by caller
 *
 * Returns an array of strings / RegExp that chokidar understands.
 */
export function buildIgnoredList(
  root: string,
  gitignorePatterns: string[],
  extraPatterns: string[],
): (string | RegExp)[] {
  const ignored: (string | RegExp)[] = [];

  // Always ignore SKIP_DIRS
  for (const dir of SKIP_DIRS) {
    // Match the directory anywhere in the tree
    ignored.push(new RegExp(`(^|[\\/\\\\])${escapeRegex(dir)}([\\/\\\\]|$)`));
  }

  // gitignore-style patterns: convert simple globs to path prefixes
  // For now, we do a best-effort conversion: patterns starting with / are
  // anchored to the root; others are matched anywhere.
  const allPatterns = [...gitignorePatterns, ...extraPatterns];
  for (const pattern of allPatterns) {
    const negated = pattern.startsWith("!");
    const rawPattern = negated ? pattern.slice(1) : pattern;
    if (negated) continue; // negation is complex; skip for safety

    if (rawPattern.startsWith("/")) {
      // Anchored to root
      ignored.push(path.join(root, rawPattern.slice(1)));
    } else if (!rawPattern.includes("/")) {
      // Simple filename / directory name — match anywhere
      ignored.push(new RegExp(`(^|[\\/\\\\])${escapeRegex(rawPattern)}([\\/\\\\]|$)`));
    } else {
      // Relative path pattern — anchor to root
      ignored.push(path.join(root, rawPattern));
    }
  }

  return ignored;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── FileWatcher Class ────────────────────────────────────────────────────────

export class FileWatcher {
  private readonly root: string;
  private readonly options: Required<FileWatcherOptions>;
  private readonly onFlush: WatchFlushCallback;

  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvents: Map<string, WatchEvent> = new Map();
  private running = false;

  constructor(root: string, onFlush: WatchFlushCallback, options: FileWatcherOptions = {}) {
    this.root = path.resolve(root);
    this.onFlush = onFlush;
    this.options = {
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      extraIgnorePatterns: options.extraIgnorePatterns ?? [],
    };
  }

  /**
   * Start watching the workspace directory.
   * Reads .gitignore patterns before starting chokidar.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const gitignorePatterns = await readGitignorePatterns(this.root);
    const ignored = buildIgnoredList(this.root, gitignorePatterns, this.options.extraIgnorePatterns);

    this.watcher = chokidar.watch(this.root, {
      ignored,
      persistent: true,
      ignoreInitial: true,       // only report changes, not initial scan
      awaitWriteFinish: {
        stabilityThreshold: 80,   // wait 80ms after last write before reporting
        pollInterval: 50,
      },
      depth: 99,
      usePolling: false,
    });

    this.watcher.on("add", (filePath: string) => this.handleEvent("add", filePath));
    this.watcher.on("change", (filePath: string) => this.handleEvent("change", filePath));
    this.watcher.on("unlink", (filePath: string) => this.handleEvent("unlink", filePath));

    // Surface watcher errors as structured log entries; do not throw
    this.watcher.on("error", (err: unknown) => {
      // Use a structured log format consistent with server log conventions
      process.stderr.write(
        `[file-watcher] error watching ${this.root}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  }

  /**
   * Stop watching and clear any pending debounce timers.
   * Flushes any accumulated events before closing.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Flush any outstanding events synchronously before closing
    await this.flush();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** True if the watcher is currently active. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Number of events currently queued in the debounce buffer. */
  get pendingCount(): number {
    return this.pendingEvents.size;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private handleEvent(kind: WatchEventKind, absolutePath: string): void {
    if (!this.running) return;

    // Filter to only indexable extensions (and unlink — we need to remove deleted files)
    if (kind !== "unlink") {
      const ext = path.extname(absolutePath).toLowerCase();
      if (!INDEXABLE_EXTENSIONS.has(ext)) return;
    }

    const relativePath = path.relative(this.root, absolutePath);

    // Deduplicate: last event for a path wins (e.g. add then change → change)
    this.pendingEvents.set(absolutePath, { kind, absolutePath, relativePath });

    // Immediate flush if queue is saturated
    if (this.pendingEvents.size >= MAX_QUEUE_SIZE) {
      if (this.debounceTimer !== null) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      void this.flush();
      return;
    }

    // Debounce: reset timer on every new event
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, this.options.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.pendingEvents.size === 0) return;

    const events = Array.from(this.pendingEvents.values());
    this.pendingEvents.clear();

    try {
      await this.onFlush(events);
    } catch (err) {
      process.stderr.write(
        `[file-watcher] flush callback error: ${(err as Error).message}\n`,
      );
    }
  }
}
