#!/usr/bin/env tsx
/**
 * connections-validate — CLI linter for .multiqlti/connections.yaml
 *
 * Usage:
 *   npx tsx script/connections-validate.ts [path/to/connections.yaml]
 *   npx tsx script/connections-validate.ts  # uses .multiqlti/connections.yaml
 *
 * Exit codes:
 *   0 — valid
 *   1 — validation errors (schema violations, plaintext secrets, parse errors)
 *   2 — file not found
 *   3 — unexpected error
 */

import fs from "fs/promises";
import path from "path";
import { validateConnectionsYaml } from "../server/workspace/connections-yaml";

const DEFAULT_PATH = ".multiqlti/connections.yaml";

async function main(): Promise<void> {
  const filePath = process.argv[2] ?? DEFAULT_PATH;
  const resolvedPath = path.resolve(filePath);

  console.log(`Validating: ${resolvedPath}\n`);

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.error(`Error: File not found: ${resolvedPath}`);
      process.exit(2);
    }
    console.error(`Error reading file: ${(err as Error).message}`);
    process.exit(3);
  }

  const result = validateConnectionsYaml(raw);

  if (result.errors.length > 0) {
    console.error("Validation errors:");
    for (const error of result.errors) {
      console.error(`  ✗ ${error}`);
    }
    console.error("");
  }

  if (result.warnings.length > 0) {
    console.warn("Warnings:");
    for (const warning of result.warnings) {
      console.warn(`  ⚠ ${warning}`);
    }
    console.warn("");
  }

  if (result.valid) {
    console.log(`✓ Valid — ${result.connectionCount} connection(s) defined`);
    if (result.warnings.length > 0) {
      console.log(`  ${result.warnings.length} warning(s) — see above`);
    }
    process.exit(0);
  } else {
    console.error(`✗ Invalid — ${result.errors.length} error(s)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${(err as Error).message}`);
  process.exit(3);
});
