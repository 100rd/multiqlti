/**
 * export-orchestrator.ts — Coordinates all per-entity-type exporters.
 *
 * Issue #316: Config sync export path (DB → YAMLs, idempotent)
 *
 * Usage:
 *   const result = await runExport(storage, repoPath, { providerKeyRows });
 *   console.log(result.summary);
 *
 * Guarantees:
 *  - Runs all exporters sequentially (safe for single-process use).
 *  - Each exporter writes atomically (tmp + rename).
 *  - Idempotent: identical DB state produces byte-identical output files.
 *  - Per-exporter failures are collected and reported but do NOT abort the
 *    orchestration — best-effort export is preferred over a total failure.
 *  - Returns a rich result object including per-exporter stats + aggregate.
 */

import type { IStorage } from "../storage.js";
import type { ProviderKeyRow } from "./exporters/provider-key-exporter.js";
import { exportPipelines } from "./exporters/pipeline-exporter.js";
import { exportTriggers } from "./exporters/trigger-exporter.js";
import { exportPrompts } from "./exporters/prompt-exporter.js";
import { exportSkills } from "./exporters/skill-exporter.js";
import { exportConnections } from "./exporters/connection-exporter.js";
import { exportProviderKeys } from "./exporters/provider-key-exporter.js";
import { exportPreferences } from "./exporters/preferences-exporter.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ExportOptions {
  /**
   * Provider key rows fetched from the DB by the caller.
   * IStorage does not expose a generic getProviderKeys() so the caller must
   * supply them (typically via a direct DB query or the settings route).
   */
  providerKeyRows?: ProviderKeyRow[];
}

export interface ExporterResult {
  name: string;
  exported: string[];
  errors: Array<{ id?: string; name?: string; provider?: string; scope?: string; error: string }>;
  skipped?: Array<{ id?: string; name?: string; provider?: string; reason: string }>;
}

export interface ExportResult {
  /** ISO-8601 timestamp of when this export ran. */
  exportedAt: string;
  /** Root of the config-sync repository. */
  repoPath: string;
  /** Per-exporter breakdown. */
  exporters: ExporterResult[];
  /** Aggregate stats. */
  summary: {
    totalExported: number;
    totalErrors: number;
    totalSkipped: number;
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the full config-sync export pipeline.
 *
 * @param storage       IStorage instance (DB or MemStorage).
 * @param repoPath      Absolute path to the config-sync repository root.
 * @param options       Optional overrides.
 * @returns             Rich result object with per-exporter stats.
 */
export async function runExport(
  storage: IStorage,
  repoPath: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const exportedAt = new Date().toISOString();
  const results: ExporterResult[] = [];

  // ── Pipelines ──────────────────────────────────────────────────────────────
  results.push(
    await runExporter("pipelines", () => exportPipelines(storage, repoPath)),
  );

  // ── Triggers ──────────────────────────────────────────────────────────────
  results.push(
    await runExporter("triggers", () => exportTriggers(storage, repoPath)),
  );

  // ── Prompts ────────────────────────────────────────────────────────────────
  results.push(
    await runExporter("prompts", () => exportPrompts(storage, repoPath)),
  );

  // ── Skills ─────────────────────────────────────────────────────────────────
  results.push(
    await runExporter("skills", () => exportSkills(storage, repoPath)),
  );

  // ── Connections ────────────────────────────────────────────────────────────
  results.push(
    await runExporter("connections", () => exportConnections(storage, repoPath)),
  );

  // ── Provider Keys ──────────────────────────────────────────────────────────
  const providerKeyRows = options.providerKeyRows ?? [];
  results.push(
    await runExporter("provider-keys", () =>
      exportProviderKeys(providerKeyRows, repoPath),
    ),
  );

  // ── Preferences ────────────────────────────────────────────────────────────
  results.push(
    await runExporter("preferences", () => exportPreferences(storage, repoPath)),
  );

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const summary = {
    totalExported: results.reduce((s, r) => s + r.exported.length, 0),
    totalErrors: results.reduce((s, r) => s + r.errors.length, 0),
    totalSkipped: results.reduce(
      (s, r) => s + (r.skipped?.length ?? 0),
      0,
    ),
  };

  return { exportedAt, repoPath, exporters: results, summary };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Wrap a single exporter call with error normalisation.
 *
 * If the exporter itself throws (unexpected, e.g. filesystem permission error),
 * that is captured as a top-level error entry rather than propagating.
 */
async function runExporter(
  name: string,
  fn: () => Promise<{
    exported: string[];
    errors: Array<Record<string, unknown>>;
    skipped?: Array<Record<string, unknown>>;
  }>,
): Promise<ExporterResult> {
  try {
    const result = await fn();
    return {
      name,
      exported: result.exported,
      errors: result.errors as ExporterResult["errors"],
      skipped: result.skipped as ExporterResult["skipped"],
    };
  } catch (err: unknown) {
    return {
      name,
      exported: [],
      errors: [
        {
          error: `Exporter "${name}" threw unexpectedly: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }
}
