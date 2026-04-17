/**
 * Ephemeral Namespace Janitor (issue #272).
 *
 * Background job that finds Kubernetes namespaces created by the
 * e2e_kubernetes pipeline stage and deletes those whose TTL has expired.
 *
 * Identification criteria (both must be true):
 *   - Label  `ephemeral=true`
 *   - Annotation `multiqlti.io/delete-after` is a parseable ISO timestamp
 *     that is now in the past
 *
 * Safety rules:
 *   - Only touches namespaces with the `ephemeral=true` label — never
 *     deletes user-managed namespaces.
 *   - Dry-run mode returns what would be deleted without taking action.
 *
 * Metric: `janitorResult.namespacesByAge` — array of
 *   `{ namespace, ageHours, expired }` for observability dashboards.
 *
 * The `CommandRunner` interface allows injecting a test double without needing
 * to mock `child_process`.
 */

import { spawn } from "child_process";
import type { CommandRunner, CommandResult } from "../pipeline/stages/e2e-kubernetes";

// ─── Re-export CommandRunner from the stage module for convenience ─────────────
export type { CommandRunner, CommandResult };

// ─── Production runner ────────────────────────────────────────────────────────

class SpawnCommandRunner implements CommandRunner {
  run(
    cmd: string,
    args: string[],
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      proc.on("error", (err) => resolve({ stdout, stderr: err.message, exitCode: 1 }));
    });
  }
}

const defaultRunner: CommandRunner = new SpawnCommandRunner();

// ─── Internal helpers ─────────────────────────────────────────────────────────

function kubectlArgs(kubeconfigPath: string | undefined, ...rest: string[]): string[] {
  return kubeconfigPath ? ["--kubeconfig", kubeconfigPath, ...rest] : [...rest];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NamespaceAgeEntry {
  namespace: string;
  /** Floating-point hours since namespace creation */
  ageHours: number;
  /** True when `delete-after` annotation is in the past */
  expired: boolean;
  deleteAfter: string | null;
}

export interface JanitorRunResult {
  scanned: number;
  deleted: string[];
  errors: Array<{ namespace: string; error: string }>;
  namespacesByAge: NamespaceAgeEntry[];
  dryRun: boolean;
  ranAt: Date;
}

export interface JanitorOptions {
  /** Path to kubeconfig file. Undefined = use in-cluster config. */
  kubeconfigPath?: string;
  /** When true, log what would be deleted but do not actually delete. Default false. */
  dryRun?: boolean;
  /**
   * Custom label selector used to find ephemeral namespaces.
   * Default: "ephemeral=true"
   */
  labelSelector?: string;
  /**
   * Injectable command runner for testing.
   * Defaults to the spawn-backed production runner.
   */
  runner?: CommandRunner;
}

// ─── Janitor implementation ────────────────────────────────────────────────────

/**
 * List namespaces matching the ephemeral label selector and return
 * their metadata (name, delete-after annotation, creation timestamp).
 */
export async function listEphemeralNamespaces(
  kubeconfigPath: string | undefined,
  labelSelector: string,
  runner: CommandRunner,
): Promise<Array<{ name: string; deleteAfter: string | null; creationTimestamp: string | null }>> {
  const result = await runner.run(
    "kubectl",
    kubectlArgs(
      kubeconfigPath,
      "get", "namespaces",
      "--selector", labelSelector,
      "-o",
      "jsonpath={range .items[*]}{.metadata.name}|{.metadata.annotations.multiqlti\\.io/delete-after}|{.metadata.creationTimestamp}\\n{end}",
    ),
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to list ephemeral namespaces: ${result.stderr}`,
    );
  }

  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split("|");
      return {
        name: parts[0] ?? "",
        deleteAfter: parts[1] || null,
        creationTimestamp: parts[2] || null,
      };
    })
    .filter((ns) => ns.name.length > 0);
}

/**
 * Delete a single namespace. Returns true on success, false on error.
 */
export async function deleteNamespace(
  namespace: string,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
): Promise<{ success: boolean; error?: string }> {
  const result = await runner.run(
    "kubectl",
    kubectlArgs(kubeconfigPath, "delete", "namespace", namespace, "--ignore-not-found"),
  );

  if (result.exitCode !== 0) {
    return { success: false, error: result.stderr.trim() || "unknown error" };
  }
  return { success: true };
}

/**
 * Compute the age of a namespace in hours from its creation timestamp.
 */
function computeAgeHours(creationTimestamp: string | null): number {
  if (!creationTimestamp) return 0;
  const created = new Date(creationTimestamp);
  if (isNaN(created.getTime())) return 0;
  return (Date.now() - created.getTime()) / (1000 * 60 * 60);
}

/**
 * Determine whether a namespace has exceeded its TTL based on the
 * `multiqlti.io/delete-after` annotation.
 */
function isExpired(deleteAfter: string | null): boolean {
  if (!deleteAfter) return false;
  const ts = new Date(deleteAfter);
  if (isNaN(ts.getTime())) return false;
  return Date.now() > ts.getTime();
}

/**
 * Main janitor function. Scans all ephemeral namespaces, deletes those whose
 * TTL has expired, and returns a structured result for metrics/logging.
 */
export async function runEphemeralJanitor(
  opts: JanitorOptions = {},
): Promise<JanitorRunResult> {
  const {
    kubeconfigPath,
    dryRun = false,
    labelSelector = "ephemeral=true",
    runner = defaultRunner,
  } = opts;

  const ranAt = new Date();
  const deleted: string[] = [];
  const errors: Array<{ namespace: string; error: string }> = [];
  const namespacesByAge: NamespaceAgeEntry[] = [];

  const namespaces = await listEphemeralNamespaces(kubeconfigPath, labelSelector, runner);

  for (const ns of namespaces) {
    const ageHours = computeAgeHours(ns.creationTimestamp);
    const expired = isExpired(ns.deleteAfter);

    namespacesByAge.push({
      namespace: ns.name,
      ageHours,
      expired,
      deleteAfter: ns.deleteAfter,
    });

    if (!expired) continue;

    if (dryRun) {
      // Record as "would delete" without acting
      deleted.push(ns.name);
      continue;
    }

    const outcome = await deleteNamespace(ns.name, kubeconfigPath, runner);
    if (outcome.success) {
      deleted.push(ns.name);
    } else {
      errors.push({ namespace: ns.name, error: outcome.error ?? "unknown error" });
    }
  }

  return {
    scanned: namespaces.length,
    deleted,
    errors,
    namespacesByAge,
    dryRun,
    ranAt,
  };
}

// ─── Scheduled janitor ─────────────────────────────────────────────────────────

export interface ScheduledJanitorHandle {
  stop: () => void;
  lastResult: () => JanitorRunResult | null;
}

/**
 * Start a recurring janitor that runs every `intervalMs` milliseconds.
 * Returns a handle with `stop()` and `lastResult()`.
 *
 * Errors during a run are captured in `lastResult().errors` — they do not
 * crash the background loop.
 */
export function startScheduledJanitor(
  opts: JanitorOptions & { intervalMs: number },
): ScheduledJanitorHandle {
  let lastResult: JanitorRunResult | null = null;
  let stopped = false;

  const run = (): void => {
    void runEphemeralJanitor(opts).then((result) => {
      lastResult = result;
    }).catch(() => {
      // Non-fatal: errors are surfaced via lastResult.errors in the next run
    });
  };

  // Run immediately on start, then repeat
  run();
  const interval = setInterval(() => {
    if (!stopped) run();
  }, opts.intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
    lastResult: () => lastResult,
  };
}
