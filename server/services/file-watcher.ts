/**
 * FileWatcher — watches filesystem paths for changes and fires triggers.
 *
 * Fix 2 (Security): All paths are resolved via fs.realpathSync to eliminate
 * symlink traversal attacks. Paths must start with WATCH_BASE_PATH and must
 * not resolve to any system-critical directories.
 */
import { watch, type FSWatcher } from "chokidar";
import { realpathSync, existsSync } from "fs";
import { resolve } from "path";
import type { TriggerRow } from "@shared/schema";
import type { FileChangeTriggerConfig } from "@shared/types";

// ─── Path security ────────────────────────────────────────────────────────────

/**
 * Absolute-path denylist. Any resolved path that starts with one of these
 * (or equals it) is rejected to prevent watching system-critical locations.
 */
const DENIED_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/run",
  "/root",
  "/var/run/docker.sock",
  "/run/secrets",
];

/**
 * Resolve the WATCH_BASE_PATH, defaulting to process.cwd() if unset.
 * Logged once at module load so misconfiguration is visible at startup.
 */
function resolveWatchBasePath(): string {
  const configured = process.env.WATCH_BASE_PATH;
  if (!configured) {
    console.warn(
      "[file-watcher] WATCH_BASE_PATH is not set — defaulting to process.cwd(). " +
        "Set WATCH_BASE_PATH to an explicit directory to restrict file watching.",
    );
    return process.cwd();
  }
  return resolve(configured);
}

const WATCH_BASE_PATH = resolveWatchBasePath();

/**
 * Validate a watch path before scheduling.
 *
 * 1. Resolve symlinks via realpathSync (or resolve() if path doesn't exist yet).
 * 2. Reject paths containing ".." after resolution (belt-and-suspenders).
 * 3. Reject paths that don't start with WATCH_BASE_PATH.
 * 4. Reject paths matching the system-critical denylist.
 *
 * Returns the resolved absolute path, or throws with a descriptive message.
 */
export function validateWatchPath(rawPath: string): string {
  // Resolve the path; if it doesn't exist yet use path.resolve for normalization
  let resolved: string;
  try {
    resolved = realpathSync(rawPath);
  } catch {
    // Path doesn't exist yet — normalize without following symlinks
    resolved = resolve(rawPath);
  }

  // Reject if ".." appears after resolution (shouldn't happen after resolve, but belt+suspenders)
  if (resolved.includes("..")) {
    throw new Error(`[file-watcher] Path traversal detected in resolved path: ${resolved}`);
  }

  // Enforce base path confinement
  const normalizedBase = WATCH_BASE_PATH.endsWith("/")
    ? WATCH_BASE_PATH
    : WATCH_BASE_PATH + "/";
  if (resolved !== WATCH_BASE_PATH && !resolved.startsWith(normalizedBase)) {
    throw new Error(
      `[file-watcher] Path "${resolved}" is outside of WATCH_BASE_PATH "${WATCH_BASE_PATH}"`,
    );
  }

  // Check against system-critical denylist
  for (const denied of DENIED_PATHS) {
    if (resolved === denied || resolved.startsWith(denied + "/")) {
      throw new Error(
        `[file-watcher] Path "${resolved}" matches a denied system path "${denied}"`,
      );
    }
  }

  return resolved;
}

// ─── FileWatcher class ────────────────────────────────────────────────────────

export interface FileWatcherDeps {
  getEnabledTriggersByType: (type: "file_change") => Promise<TriggerRow[]>;
  fireTrigger: (trigger: TriggerRow, payload: unknown) => Promise<void>;
}

interface WatcherEntry {
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export class FileWatcherService {
  private readonly watchers: Map<string, WatcherEntry> = new Map();
  private readonly deps: FileWatcherDeps;

  constructor(deps: FileWatcherDeps) {
    this.deps = deps;
  }

  /** Load all enabled file_change triggers and start watching. */
  async bootstrap(): Promise<void> {
    const triggers = await this.deps.getEnabledTriggersByType("file_change");
    for (const trigger of triggers) {
      this.watchTrigger(trigger);
    }
  }

  /** Start watching for a single trigger. Replaces any existing watcher. */
  watchTrigger(trigger: TriggerRow): void {
    this.unwatchTrigger(trigger.id);

    const config = trigger.config as FileChangeTriggerConfig;

    let resolvedPath: string;
    try {
      resolvedPath = validateWatchPath(config.watchPath);
    } catch (e) {
      console.error(`[file-watcher] Skipping trigger ${trigger.id}: ${(e as Error).message}`);
      return;
    }

    const debounceMs = config.debounceMs ?? 500;

    const watcher = watch(resolvedPath, {
      ignored: /(^|[/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    const entry: WatcherEntry = { watcher, debounceTimer: null };
    this.watchers.set(trigger.id, entry);

    const fire = (filePath: string, event: string) => {
      if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(async () => {
        try {
          await this.deps.fireTrigger(trigger, {
            filePath,
            event,
            watchPath: resolvedPath,
            input: config.input?.replace("{{filePath}}", filePath),
          });
        } catch (e) {
          console.error(`[file-watcher] Error firing trigger ${trigger.id}:`, e);
        }
      }, debounceMs);
    };

    watcher.on("change", (p) => fire(p, "change"));
    watcher.on("add", (p) => fire(p, "add"));
    watcher.on("unlink", (p) => fire(p, "unlink"));
    watcher.on("error", (err) => {
      console.error(`[file-watcher] Watcher error for trigger ${trigger.id}:`, err);
    });
  }

  /** Stop watching for a single trigger. */
  unwatchTrigger(id: string): void {
    const entry = this.watchers.get(id);
    if (entry) {
      if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
      void entry.watcher.close();
      this.watchers.delete(id);
    }
  }

  /** Stop all watchers. */
  stopAll(): void {
    for (const id of this.watchers.keys()) {
      this.unwatchTrigger(id);
    }
  }

  /** Number of active watchers. */
  get size(): number {
    return this.watchers.size;
  }
}

// Re-export for use in tests
export { WATCH_BASE_PATH, DENIED_PATHS };
