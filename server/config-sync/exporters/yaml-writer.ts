/**
 * yaml-writer.ts — Stable, atomic YAML file writer for config-sync exporters.
 *
 * Guarantees:
 *  - Atomic writes: content is written to a temp file then renamed, so readers
 *    never see a partial file.
 *  - Idempotent output: object keys are sorted recursively before serialisation
 *    so repeated exports of unchanged data produce byte-identical files.
 *  - The header comment includes the API version and kind for discoverability.
 */

import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { randomBytes } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Options for writeYaml. */
export interface WriteYamlOptions {
  /** Human-readable comment written at the top of the file. */
  comment?: string;
  /** Line width passed to js-yaml dump (default: 120). */
  lineWidth?: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Serialize an object to YAML and write it atomically to `filePath`.
 *
 * The write is atomic: a temp file `<filePath>.tmp.<random>` is written first,
 * then renamed over the destination.  On POSIX this is an atomic operation.
 *
 * Keys are sorted recursively to guarantee idempotent output.
 */
export async function writeYaml(
  filePath: string,
  data: unknown,
  options: WriteYamlOptions = {},
): Promise<void> {
  const sorted = sortKeysDeep(data);

  const yamlBody = yaml.dump(sorted, {
    indent: 2,
    lineWidth: options.lineWidth ?? 120,
    noRefs: true,
    sortKeys: false,           // we sort ourselves for full recursive control
    quotingType: '"',
    forceQuotes: false,
  });

  const parts: string[] = [];
  if (options.comment) {
    // Prefix each comment line with '# '
    for (const line of options.comment.split("\n")) {
      parts.push(`# ${line}`);
    }
    parts.push("");            // blank separator line
  }
  parts.push(yamlBody);

  const content = parts.join("\n");

  // Write to a temp file then rename (atomic on POSIX)
  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Recursively sort object keys so that YAML output is deterministic.
 *
 * Arrays are preserved in their original order (semantic order matters for
 * pipeline stages, etc.).  Non-object/non-array primitives are returned as-is.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}
