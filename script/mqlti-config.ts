#!/usr/bin/env tsx
/**
 * mqlti config — Config-sync CLI subcommand
 *
 * Usage:
 *   npx tsx script/mqlti-config.ts <subcommand> [options]
 *   npx tsx script/mqlti-config.ts --help
 *
 * Subcommands:
 *   init <path>        Create a new config-sync repository
 *   status             Show sync state and git status
 *   export             Export live config to YAML files (issue #316)
 *   apply              [stub] Apply YAML files to running instance
 *   diff               [stub] Show diff between local YAML and live config
 *   push               [stub] Push local changes to remote git
 *   pull               [stub] Pull remote changes and apply
 *   secrets add <src>  Encrypt a file for all repo recipients
 *   secrets rotate     Regenerate machine keys + re-encrypt all .secret files
 *   secrets list       Show recipients in each .secret file
 *
 * Flags:
 *   --json        Output machine-readable JSON
 *   --help, -h    Show help
 *
 * Exit codes:
 *   0 — success
 *   1 — user error (bad args, bad state)
 *   2 — internal error (unexpected exception)
 */

import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import simpleGit from "simple-git";
import yaml from "js-yaml";
import chalk from "chalk";

import {
  generateKeyPair,
  serializeKeyPair,
  deserializeKeyPair,
  loadOrCreateKeyPair,
  buildPublicKeyRecord,
  parsePublicKeyRecord,
  loadPublicKeys,
  encryptFile,
  parseEncryptedFile,
  reEncryptAll,
  type AgeKeyPair,
} from "../server/config-sync/age-crypto.js";


// ─── Constants ────────────────────────────────────────────────────────────────

/** All entity directory names that init creates. */
const ENTITY_DIRS = [
  "pipelines",
  "triggers",
  "connections",
  "provider-keys",
  "prompts",
  "skill-states",
  "preferences",
] as const;

/** Name of the per-repo meta file. */
const META_FILE_NAME = ".mqlti-config.yaml";

/** Version of the meta schema used in this tool. */
const META_SCHEMA_VERSION = "1.0.0";

/** Default location for the machine private key. */
const DEFAULT_AGE_KEY_FILE = path.join(
  os.homedir(),
  ".config",
  "mqlti",
  "age-keys.txt",
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface MetaFile {
  schemaVersion: string;
  createdAt: string;
  lastExportAt: string | null;
  lastApplyAt: string | null;
  lastPushAt: string | null;
  lastPullAt: string | null;
}

interface JsonResult {
  ok: boolean;
  subcommand: string;
  data?: unknown;
  error?: string;
}

// ─── Help text ────────────────────────────────────────────────────────────────

const HELP_TEXT = `
${chalk.bold("mqlti config")} — Config-sync CLI

${chalk.bold("Usage:")}
  npx tsx script/mqlti-config.ts <subcommand> [options]

${chalk.bold("Subcommands:")}
  ${chalk.cyan("init <path>")}          Create a config-sync repository at <path>
  ${chalk.cyan("status")}               Show git state and sync timestamps
  ${chalk.cyan("export")}               Export live config to YAML files
  ${chalk.cyan("apply [--dry-run] [--force]")}   Apply YAML files to the running instance
  ${chalk.cyan("diff")}                             Diff local YAML vs live config
  ${chalk.cyan("push")}                 Push local changes to remote git (requires #319)
  ${chalk.cyan("pull")}                 Pull remote changes and apply (requires #320)
  ${chalk.cyan("secrets add <src>")}    Encrypt <src> for all repo recipients
  ${chalk.cyan("secrets rotate")}       Regenerate keys + re-encrypt all .secret files
  ${chalk.cyan("secrets list")}         List recipients in each .secret file

${chalk.bold("Options:")}
  ${chalk.yellow("--json")}              Output machine-readable JSON
  ${chalk.yellow("--help, -h")}          Show this help message
  ${chalk.yellow("--key-file <path>")}   Override machine key file (default: ~/.config/mqlti/age-keys.txt)
  ${chalk.yellow("--dry-run")}           (apply/diff) Show changes without writing to DB
  ${chalk.yellow("--force")}             (apply) Apply even when DB conflicts are detected

${chalk.bold("Exit codes:")}
  0   Success
  1   User error (bad arguments, bad state)
  2   Internal error (unexpected exception)

${chalk.bold("Examples:")}
  npx tsx script/mqlti-config.ts init ./my-config-repo
  npx tsx script/mqlti-config.ts status
  npx tsx script/mqlti-config.ts export
  npx tsx script/mqlti-config.ts diff
  npx tsx script/mqlti-config.ts apply --dry-run
  npx tsx script/mqlti-config.ts apply --force
  npx tsx script/mqlti-config.ts secrets add connections/gitlab-main.yaml
  npx tsx script/mqlti-config.ts secrets list
  npx tsx script/mqlti-config.ts secrets rotate
`.trim();

// ─── Output helpers ───────────────────────────────────────────────────────────

let jsonMode = false;

function setJsonMode(value: boolean): void {
  jsonMode = value;
}

function printJson(result: JsonResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function printSuccess(message: string): void {
  if (!jsonMode) console.log(chalk.green("✓") + " " + message);
}

function printInfo(message: string): void {
  if (!jsonMode) console.log(message);
}

function printError(message: string): void {
  if (!jsonMode) {
    console.error(chalk.red("✗") + " " + message);
  }
}

function printWarn(message: string): void {
  if (!jsonMode) {
    console.warn(chalk.yellow("⚠") + " " + message);
  }
}

// ─── Meta file helpers ────────────────────────────────────────────────────────

function buildInitialMeta(): MetaFile {
  return {
    schemaVersion: META_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    lastExportAt: null,
    lastApplyAt: null,
    lastPushAt: null,
    lastPullAt: null,
  };
}

async function writeMeta(repoPath: string, meta: MetaFile): Promise<void> {
  const metaPath = path.join(repoPath, META_FILE_NAME);
  const content =
    [
      "# mqlti config-sync repository metadata",
      "# Do not edit manually — managed by `mqlti config` CLI",
      yaml.dump(meta, { lineWidth: 100 }).trim(),
    ].join("\n") + "\n";
  await fs.writeFile(metaPath, content, "utf-8");
}

async function readMeta(repoPath: string): Promise<MetaFile | null> {
  const metaPath = path.join(repoPath, META_FILE_NAME);
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    const parsed = yaml.load(raw);
    if (parsed == null || typeof parsed !== "object") return null;
    return parsed as MetaFile;
  } catch {
    return null;
  }
}

async function findConfigRepo(): Promise<string | null> {
  // Walk up from CWD looking for a directory containing META_FILE_NAME
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, META_FILE_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ─── init ─────────────────────────────────────────────────────────────────────

async function cmdInit(targetPath: string): Promise<void> {
  const repoPath = path.resolve(targetPath);

  // Create root directory if it doesn't exist
  await fs.mkdir(repoPath, { recursive: true });

  // Refuse to re-init if meta file already exists
  const existingMeta = await readMeta(repoPath);
  if (existingMeta !== null) {
    if (jsonMode) {
      printJson({
        ok: false,
        subcommand: "init",
        error: `Config repo already initialised at ${repoPath}`,
      });
    } else {
      printError(`Config repo already initialised at ${repoPath}`);
      printInfo(`  Run ${chalk.cyan("mqlti config status")} to see current state.`);
    }
    process.exit(1);
  }

  // Create entity subdirectories
  for (const dir of ENTITY_DIRS) {
    const fullDir = path.join(repoPath, dir);
    await fs.mkdir(fullDir, { recursive: true });
    // Write a .gitkeep so git tracks the empty directory
    await fs.writeFile(path.join(fullDir, ".gitkeep"), "");
  }

  // Create public-keys directory
  const pkDir = path.join(repoPath, "public-keys");
  await fs.mkdir(pkDir, { recursive: true });
  await fs.writeFile(path.join(pkDir, ".gitkeep"), "");

  // Write .gitignore
  const gitignoreContent =
    [
      "# mqlti config-sync — never commit plaintext secrets",
      "*.secret",
      "*.key",
      "*.pem",
      ".env",
      ".env.*",
      "# OS noise",
      ".DS_Store",
      "Thumbs.db",
    ].join("\n") + "\n";
  await fs.writeFile(path.join(repoPath, ".gitignore"), gitignoreContent, "utf-8");

  // Write meta file
  const meta = buildInitialMeta();
  await writeMeta(repoPath, meta);

  // Run git init
  const git = simpleGit(repoPath);
  await git.init();

  if (jsonMode) {
    printJson({
      ok: true,
      subcommand: "init",
      data: {
        path: repoPath,
        entityDirs: [...ENTITY_DIRS],
        metaFile: META_FILE_NAME,
        createdAt: meta.createdAt,
      },
    });
  } else {
    printSuccess(`Initialised config repo at ${chalk.bold(repoPath)}`);
    printInfo("");
    printInfo("  Directories created:");
    for (const dir of ENTITY_DIRS) {
      printInfo(`    ${chalk.dim(dir + "/")}`);
    }
    printInfo(`    ${chalk.dim("public-keys/")}`);
    printInfo("");
    printInfo(`  ${chalk.dim(META_FILE_NAME)} — sync metadata`);
    printInfo(`  ${chalk.dim(".gitignore")}        — blocks secret files`);
    printInfo("");
    printInfo(`  Git repository initialised.`);
    printInfo(`  Next: run ${chalk.cyan("mqlti config status")} to verify.`);
  }
}

// ─── status ───────────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const repoPath = await findConfigRepo();
  if (repoPath === null) {
    if (jsonMode) {
      printJson({
        ok: false,
        subcommand: "status",
        error: "No config repo found. Run `mqlti config init <path>` to create one.",
      });
    } else {
      printError("No config repo found in current directory or any parent.");
      printInfo(`  Run ${chalk.cyan("mqlti config init <path>")} to create one.`);
    }
    process.exit(1);
  }

  const meta = await readMeta(repoPath);
  if (meta === null) {
    if (jsonMode) {
      printJson({
        ok: false,
        subcommand: "status",
        error: `Could not read ${META_FILE_NAME} at ${repoPath}`,
      });
    } else {
      printError(`Could not read ${META_FILE_NAME} at ${repoPath}`);
    }
    process.exit(2);
  }

  // Query git state
  const git = simpleGit(repoPath);
  let gitInfo: {
    branch: string;
    dirty: boolean;
    ahead: number;
    behind: number;
    staged: number;
    unstaged: number;
    untracked: number;
  };

  try {
    const [statusResult, branchResult] = await Promise.all([
      git.status(),
      git.branchLocal(),
    ]);

    gitInfo = {
      branch: branchResult.current ?? "(detached)",
      dirty: !statusResult.isClean(),
      ahead: statusResult.ahead,
      behind: statusResult.behind,
      staged: statusResult.staged.length,
      unstaged:
        statusResult.modified.length +
        statusResult.deleted.length +
        statusResult.renamed.length,
      untracked: statusResult.not_added.length,
    };
  } catch {
    // Git repo may exist but have no commits yet
    gitInfo = {
      branch: "(no commits yet)",
      dirty: false,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
    };
  }

  if (jsonMode) {
    printJson({
      ok: true,
      subcommand: "status",
      data: {
        repoPath,
        git: gitInfo,
        sync: {
          lastExportAt: meta.lastExportAt,
          lastApplyAt: meta.lastApplyAt,
          lastPushAt: meta.lastPushAt,
          lastPullAt: meta.lastPullAt,
        },
        meta: {
          schemaVersion: meta.schemaVersion,
          createdAt: meta.createdAt,
        },
      },
    });
    return;
  }

  // Human-readable output
  printInfo(chalk.bold("Config repo: ") + repoPath);
  printInfo("");

  // Git section
  printInfo(chalk.bold("Git state:"));
  const branchLabel =
    gitInfo.branch === "(no commits yet)" || gitInfo.branch === "(detached)"
      ? chalk.yellow(gitInfo.branch)
      : chalk.cyan(gitInfo.branch);
  printInfo(`  Branch:    ${branchLabel}`);

  const dirtyLabel = gitInfo.dirty ? chalk.yellow("dirty") : chalk.green("clean");
  printInfo(`  Worktree:  ${dirtyLabel}`);

  if (gitInfo.staged > 0) {
    printInfo(`  Staged:    ${chalk.yellow(String(gitInfo.staged))} file(s)`);
  }
  if (gitInfo.unstaged > 0) {
    printInfo(`  Modified:  ${chalk.yellow(String(gitInfo.unstaged))} file(s)`);
  }
  if (gitInfo.untracked > 0) {
    printInfo(`  Untracked: ${chalk.yellow(String(gitInfo.untracked))} file(s)`);
  }

  if (gitInfo.ahead > 0 || gitInfo.behind > 0) {
    const parts: string[] = [];
    if (gitInfo.ahead > 0) parts.push(chalk.cyan(`↑${gitInfo.ahead} ahead`));
    if (gitInfo.behind > 0) parts.push(chalk.yellow(`↓${gitInfo.behind} behind`));
    printInfo(`  Remote:    ${parts.join(", ")}`);
  } else if (
    gitInfo.branch !== "(no commits yet)" &&
    gitInfo.branch !== "(detached)"
  ) {
    printInfo(`  Remote:    ${chalk.green("up to date")}`);
  }

  printInfo("");

  // Sync timestamps section
  printInfo(chalk.bold("Sync timestamps:"));
  const fmt = (ts: string | null): string =>
    ts === null ? chalk.dim("never") : chalk.white(ts);
  printInfo(`  Last export: ${fmt(meta.lastExportAt)}`);
  printInfo(`  Last apply:  ${fmt(meta.lastApplyAt)}`);
  printInfo(`  Last push:   ${fmt(meta.lastPushAt)}`);
  printInfo(`  Last pull:   ${fmt(meta.lastPullAt)}`);

  printInfo("");
  printInfo(
    chalk.dim(`Schema version: ${meta.schemaVersion}  |  Created: ${meta.createdAt}`),
  );
}

// ─── export ───────────────────────────────────────────────────────────────────

/**
 * `export` — Export live config from DB to YAML files in the config repo.
 *
 * Reads from the storage instance (DB or MemStorage), validates each entity
 * against the Zod schema, and writes atomic YAML files.  Idempotent: repeated
 * runs with unchanged state produce byte-identical files.
 *
 * After a successful export, updates `lastExportAt` in `.mqlti-config.yaml`.
 */
async function cmdExport(): Promise<void> {
  const repoPath = await requireConfigRepo("export");

  printInfo(chalk.bold("Exporting config from DB → YAML…"));
  printInfo("");

  // Dynamic imports: keep @shared/* resolution inside the function so the
  // CLI can be spawned from any cwd without tsx needing to find tsconfig.json.
  const { runExport } = await import(
    new URL("../server/config-sync/export-orchestrator.js", import.meta.url).href,
  );
  const { storage } = await import(
    new URL("../server/storage.js", import.meta.url).href,
  );

  const result = await runExport(storage, repoPath);

  // Update meta file with export timestamp
  const meta = await readMeta(repoPath);
  if (meta) {
    await writeMeta(repoPath, { ...meta, lastExportAt: result.exportedAt });
  }

  if (jsonMode) {
    printJson({
      ok: result.summary.totalErrors === 0,
      subcommand: "export",
      data: result,
    });
    if (result.summary.totalErrors > 0) {
      process.exit(1);
    }
    return;
  }

  // Human-readable output
  for (const exp of result.exporters) {
    const count = exp.exported.length;
    const errCount = exp.errors.length;
    const skipCount = exp.skipped?.length ?? 0;

    const statusIcon = errCount > 0 ? chalk.yellow("⚠") : chalk.green("✓");
    const details: string[] = [`${count} file(s)`];
    if (errCount > 0) details.push(chalk.red(`${errCount} error(s)`));
    if (skipCount > 0) details.push(chalk.dim(`${skipCount} skipped`));

    printInfo(`  ${statusIcon} ${chalk.cyan(exp.name.padEnd(16))} ${details.join("  ")}`);

    for (const e of exp.errors) {
      const label = e.name ?? e.provider ?? e.scope ?? e.id ?? "unknown";
      printInfo(`       ${chalk.red("✗")} ${label}: ${e.error}`);
    }
  }

  printInfo("");
  printInfo(
    chalk.bold("Summary:") +
      `  ${chalk.green(String(result.summary.totalExported))} exported` +
      (result.summary.totalErrors > 0
        ? `  ${chalk.red(String(result.summary.totalErrors))} errors`
        : "") +
      (result.summary.totalSkipped > 0
        ? `  ${chalk.dim(String(result.summary.totalSkipped))} skipped`
        : ""),
  );
  printInfo(chalk.dim(`  Exported at: ${result.exportedAt}`));

  if (result.summary.totalErrors > 0) {
    printInfo("");
    printWarn("Some entities failed to export. Check errors above.");
    process.exit(1);
  }
}


// ─── apply ────────────────────────────────────────────────────────────────────

/**
 * `apply` — Apply YAML files from the config repo to the running instance.
 *
 * 1. Loads current DB state for each entity type.
 * 2. Computes a create/update/delete diff per entity type.
 * 3. Checks for conflicts (DB modified after last export).
 * 4. Applies atomically (all-or-nothing with rollback on error).
 * 5. Records audit entry.
 * 6. Updates `lastApplyAt` in `.mqlti-config.yaml`.
 *
 * With `--dry-run`: prints the diff but writes nothing.
 * With `--force`: applies even when DB conflicts are detected.
 */
async function cmdApply(dryRun: boolean, force: boolean): Promise<void> {
  const repoPath = await requireConfigRepo("apply");
  const meta = await readMeta(repoPath);

  printInfo(chalk.bold(dryRun ? "Dry-run: computing diff (no writes)…" : "Applying config from YAML → DB…"));
  printInfo("");

  const { runApply: _runApply } = await import(
    new URL("../server/config-sync/apply-orchestrator.js", import.meta.url).href,
  );
  const { storage: _storage } = await import(
    new URL("../server/storage.js", import.meta.url).href,
  );

  const result = await _runApply(_storage, repoPath, {
    dryRun,
    force,
    lastExportAt: meta?.lastExportAt ?? null,
    appliedBy: process.env["USER"] ?? "cli",
  });

  // Update meta file with apply timestamp (skip for dry-run)
  if (!dryRun && !result.abortedDueToConflicts && meta) {
    await writeMeta(repoPath, { ...meta, lastApplyAt: result.appliedAt });
  }

  if (jsonMode) {
    printJson({
      ok: !result.abortedDueToConflicts && result.totalErrors === 0,
      subcommand: "apply",
      data: {
        dryRun,
        appliedAt: result.appliedAt,
        abortedDueToConflicts: result.abortedDueToConflicts,
        summaries: result.summaries,
        conflicts: result.conflicts,
        totalCreated: result.totalCreated,
        totalUpdated: result.totalUpdated,
        totalDeleted: result.totalDeleted,
        totalErrors: result.totalErrors,
      },
    });
    if (result.abortedDueToConflicts || result.totalErrors > 0) {
      process.exit(1);
    }
    return;
  }

  // ── Conflict abort ──────────────────────────────────────────────────────────
  if (result.abortedDueToConflicts) {
    printInfo(chalk.yellow("⚠  Aborted: DB has out-of-band modifications since last export."));
    printInfo("");
    for (const c of result.conflicts) {
      printInfo(`  ${chalk.red("✗")} ${chalk.bold(c.entityType)} / ${chalk.cyan(c.label)}`);
      printInfo(`       DB updated: ${c.dbUpdatedAt}  |  Last export: ${c.lastExportAt}`);
    }
    printInfo("");
    printInfo(
      `  Re-export first (${chalk.cyan("mqlti config export")}) or use ${chalk.yellow("--force")} to override.`,
    );
    process.exit(1);
  }

  // ── Conflict warnings (--force was set) ────────────────────────────────────
  if (result.conflicts.length > 0) {
    printWarn(`${result.conflicts.length} conflict(s) detected but --force is set — applying anyway.`);
    for (const c of result.conflicts) {
      printInfo(`  ${chalk.yellow("⚠")} ${chalk.bold(c.entityType)} / ${chalk.cyan(c.label)}: ${c.message}`);
    }
    printInfo("");
  }

  // ── Per-entity-type summary ─────────────────────────────────────────────────
  for (const s of result.summaries) {
    const hasChanges = s.created + s.updated + s.deleted + s.errors > 0;
    if (!hasChanges && s.parseErrors === 0) continue;

    const statusIcon = s.errors > 0 || s.parseErrors > 0
      ? chalk.yellow("⚠")
      : chalk.green("✓");

    const parts: string[] = [];
    if (s.created > 0) parts.push(chalk.green(`+${s.created}`));
    if (s.updated > 0) parts.push(chalk.blue(`~${s.updated}`));
    if (s.deleted > 0) parts.push(chalk.red(`-${s.deleted}`));
    if (s.errors > 0) parts.push(chalk.red(`${s.errors} error(s)`));
    if (s.parseErrors > 0) parts.push(chalk.yellow(`${s.parseErrors} parse error(s)`));

    printInfo(`  ${statusIcon} ${chalk.cyan(s.entityType.padEnd(14))} ${parts.join("  ")}`);
  }

  // ── Rollback notice ────────────────────────────────────────────────────────
  if (result.totalErrors > 0 && !dryRun) {
    printInfo("");
    printWarn("Errors occurred — rollback attempted.  DB state may be partially modified.");
  }

  printInfo("");
  const actionLabel = dryRun ? "Would apply" : "Applied";
  printInfo(
    chalk.bold(`${actionLabel}:`) +
      `  ${chalk.green("+" + result.totalCreated)} created` +
      `  ${chalk.blue("~" + result.totalUpdated)} updated` +
      `  ${chalk.red("-" + result.totalDeleted)} deleted` +
      (result.totalErrors > 0 ? `  ${chalk.red(result.totalErrors + " error(s)")}` : ""),
  );
  if (dryRun) {
    printInfo(chalk.dim("  Dry-run: no changes written to DB."));
  } else {
    printInfo(chalk.dim(`  Applied at: ${result.appliedAt}`));
  }

  if (result.totalErrors > 0) {
    process.exit(1);
  }
}

// ─── diff ─────────────────────────────────────────────────────────────────────

/**
 * `diff` — Show the diff between local YAML files and the live DB state.
 *
 * Equivalent to `apply --dry-run` but with a more detailed diff-style output.
 */
async function cmdDiff(): Promise<void> {
  const repoPath = await requireConfigRepo("diff");
  const meta = await readMeta(repoPath);

  printInfo(chalk.bold("Computing diff between YAML repo and live DB…"));
  printInfo("");

  const { runApply: _runApply } = await import(
    new URL("../server/config-sync/apply-orchestrator.js", import.meta.url).href,
  );
  const { storage: _storage } = await import(
    new URL("../server/storage.js", import.meta.url).href,
  );

  const result = await _runApply(_storage, repoPath, {
    dryRun: true,
    force: true, // show conflicts but don't abort
    lastExportAt: meta?.lastExportAt ?? null,
    appliedBy: "diff",
  });

  if (jsonMode) {
    printJson({
      ok: true,
      subcommand: "diff",
      data: {
        repoPath: result.repoPath,
        diffedAt: result.appliedAt,
        summaries: result.summaries,
        conflicts: result.conflicts,
        totalCreated: result.totalCreated,
        totalUpdated: result.totalUpdated,
        totalDeleted: result.totalDeleted,
      },
    });
    return;
  }

  // ── Conflicts ───────────────────────────────────────────────────────────────
  if (result.conflicts.length > 0) {
    printInfo(chalk.yellow(`⚠  ${result.conflicts.length} conflict(s) detected (DB modified after last export):`));
    for (const c of result.conflicts) {
      printInfo(`  ${chalk.yellow("⚠")} ${chalk.bold(c.entityType)} / ${chalk.cyan(c.label)}`);
      printInfo(`       DB updated: ${c.dbUpdatedAt}  |  Last export: ${c.lastExportAt}`);
    }
    printInfo("");
  }

  // ── Per-entity diff ─────────────────────────────────────────────────────────
  let totalChanges = 0;

  for (const diff of result.diffs) {
    const creates = diff.entries.filter((e) => e.kind === "create");
    const updates = diff.entries.filter((e) => e.kind === "update");
    const deletes = diff.entries.filter((e) => e.kind === "delete");
    const hasChanges = creates.length + updates.length + deletes.length > 0;

    if (!hasChanges && diff.parseErrors.length === 0) continue;
    totalChanges += creates.length + updates.length + deletes.length;

    printInfo(chalk.bold(`  ${diff.entityType}:`));

    for (const e of creates) {
      printInfo(`    ${chalk.green("+")} ${e.label}`);
    }
    for (const e of updates) {
      const conflictMark = e.conflict ? chalk.yellow(" ⚠ CONFLICT") : "";
      printInfo(`    ${chalk.blue("~")} ${e.label}${conflictMark}`);
      if (e.diff && Object.keys(e.diff).length > 0) {
        for (const [field, [before, after]] of Object.entries(e.diff)) {
          const bStr = JSON.stringify(before).slice(0, 60);
          const aStr = JSON.stringify(after).slice(0, 60);
          printInfo(`        ${chalk.dim(field + ":")} ${chalk.red(bStr)} → ${chalk.green(aStr)}`);
        }
      }
    }
    for (const e of deletes) {
      printInfo(`    ${chalk.red("-")} ${e.label}`);
    }
    for (const pe of diff.parseErrors) {
      printInfo(`    ${chalk.yellow("!")} Parse error: ${pe.filePath}: ${pe.error}`);
    }

    printInfo("");
  }

  if (totalChanges === 0) {
    printInfo(chalk.green("✓  No changes — DB is in sync with YAML repo."));
  } else {
    printInfo(
      chalk.bold("Summary:") +
        `  ${chalk.green("+" + result.totalCreated)} to create` +
        `  ${chalk.blue("~" + result.totalUpdated)} to update` +
        `  ${chalk.red("-" + result.totalDeleted)} to delete`,
    );
    printInfo(
      chalk.dim(`  Run ${chalk.cyan("mqlti config apply")} to apply, or ${chalk.cyan("mqlti config apply --dry-run")} to preview.`),
    );
  }
}

// ─── secrets ─────────────────────────────────────────────────────────────────

/**
 * Require the CWD to be inside a config repo.  Returns the repo root.
 */
async function requireConfigRepo(subcommand: string): Promise<string> {
  const repoPath = await findConfigRepo();
  if (repoPath === null) {
    if (jsonMode) {
      printJson({
        ok: false,
        subcommand,
        error: "No config repo found. Run `mqlti config init <path>` first.",
      });
    } else {
      printError("No config repo found in current directory or any parent.");
      printInfo(`  Run ${chalk.cyan("mqlti config init <path>")} to create one.`);
    }
    process.exit(1);
  }
  return repoPath;
}

/**
 * `secrets add <src>` — encrypt a file for all repo recipients.
 *
 * 1. Reads public keys from public-keys/*.json in the repo.
 * 2. Encrypts <src> → <src>.secret
 * 3. Adds the source path to .gitignore (if not already present).
 */
async function cmdSecretsAdd(
  sourcePath: string,
  keyFile: string,
): Promise<void> {
  const repoPath = await requireConfigRepo("secrets add");

  const absSource = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(process.cwd(), sourcePath);

  // Ensure the source file exists
  try {
    await fs.access(absSource);
  } catch {
    if (jsonMode) {
      printJson({
        ok: false,
        subcommand: "secrets add",
        error: `Source file not found: ${absSource}`,
      });
    } else {
      printError(`Source file not found: ${absSource}`);
    }
    process.exit(1);
  }

  // Load recipient public keys from the repo
  const publicKeysDir = path.join(repoPath, "public-keys");
  const keyRecords = await loadPublicKeys(publicKeysDir);

  if (keyRecords.length === 0) {
    if (jsonMode) {
      printJson({
        ok: false,
        subcommand: "secrets add",
        error: "No public keys found in public-keys/. Add at least one machine key first.",
      });
    } else {
      printError("No public keys found in public-keys/.");
      printInfo(
        "  Add a machine public key with: " +
        chalk.cyan("mqlti config secrets rotate") +
        " (generates key + exports it)",
      );
    }
    process.exit(1);
  }

  // Encrypt the file
  const secretPath = absSource + ".secret";
  await encryptFile(absSource, keyRecords, secretPath);

  // Add source path to .gitignore (relative to repo root)
  const relSource = path.relative(repoPath, absSource);
  await appendToGitignore(repoPath, relSource);

  if (jsonMode) {
    printJson({
      ok: true,
      subcommand: "secrets add",
      data: {
        source: absSource,
        secret: secretPath,
        recipients: keyRecords.map((r) => ({ name: r.name, publicKey: r.publicKey })),
      },
    });
  } else {
    printSuccess(`Encrypted → ${chalk.bold(path.relative(process.cwd(), secretPath))}`);
    printInfo(`  Recipients (${keyRecords.length}):`);
    for (const r of keyRecords) {
      printInfo(`    ${chalk.cyan(r.name)}  ${chalk.dim(r.publicKey)}`);
    }
    printInfo(`  ${chalk.dim(relSource)} added to .gitignore`);
  }

  // suppress unused import warning (loadOrCreateKeyPair used indirectly by keyFile param)
  void keyFile;
}

/**
 * `secrets rotate` — regenerate this machine's key pair and re-encrypt all
 * .secret files in the repo.
 *
 * Workflow:
 *   1. Load the OLD key from keyFile (if it exists) — needed to decrypt existing
 *      .secret files.
 *   2. Generate a new key pair.
 *   3. Write new key to keyFile (overwrites old).
 *   4. Export new public key → public-keys/<hostname>.json in the repo.
 *   5. Scan repo for all .secret files.
 *   6. Re-encrypt each .secret:
 *      - decrypt with the OLD key (or new key if no .secret files existed)
 *      - encrypt for the complete new recipient list.
 *
 * NOTE: Must be run by a machine that already holds a valid decrypt key when
 * .secret files exist.  New machines should be added by an existing keyholder
 * who runs rotate on their own machine after adding the new public key.
 */
async function cmdSecretsRotate(keyFile: string): Promise<void> {
  const repoPath = await requireConfigRepo("secrets rotate");

  // Step 1: Load the old key (if it exists) so we can decrypt existing secrets.
  let oldDecryptKey: import("crypto").KeyObject | null = null;
  try {
    const oldContent = await fs.readFile(keyFile, "utf-8");
    const oldKp = deserializeKeyPair(oldContent);
    oldDecryptKey = oldKp.privateKey;
  } catch {
    // Key file doesn't exist yet — this is a first-time setup, no secrets to re-encrypt.
    oldDecryptKey = null;
  }

  // Step 2: Generate a new key pair.
  const newKp = generateKeyPair(hostnameLabel());

  // Step 3: Write new key to key file (overwrites old).
  await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(keyFile, serializeKeyPair(newKp), { mode: 0o600 });

  // Step 4: Export public key to the repo.
  const publicKeysDir = path.join(repoPath, "public-keys");
  await fs.mkdir(publicKeysDir, { recursive: true });
  const record = buildPublicKeyRecord(newKp);
  const pkFilename = `${sanitizeFilename(newKp.name ?? hostnameLabel())}.json`;
  const pkPath = path.join(publicKeysDir, pkFilename);
  await fs.writeFile(pkPath, JSON.stringify(record, null, 2) + "\n", "utf-8");

  // Step 5: Load all recipient public keys (now includes the new one).
  const keyRecords = await loadPublicKeys(publicKeysDir);

  // Step 6: Re-encrypt all .secret files.
  const secretPaths = await findSecretFiles(repoPath);
  let reEncrypted = 0;

  if (secretPaths.length > 0) {
    // Use the old key to decrypt (it was the recipient in the old .secret files).
    // Fall back to the new key if no old key was loaded (shouldn't happen in practice
    // since old .secret files would only exist if an old key existed).
    const decryptKey = oldDecryptKey ?? newKp.privateKey;
    await reEncryptAll(secretPaths, decryptKey, keyRecords);
    reEncrypted = secretPaths.length;
  }

  if (jsonMode) {
    printJson({
      ok: true,
      subcommand: "secrets rotate",
      data: {
        keyFile,
        publicKeyFile: pkPath,
        publicKey: newKp.publicKeyHex,
        name: newKp.name,
        recipients: keyRecords.map((r) => ({ name: r.name, publicKey: r.publicKey })),
        reEncryptedCount: reEncrypted,
        reEncryptedFiles: secretPaths,
      },
    });
  } else {
    printSuccess(`New key pair generated → ${chalk.bold(keyFile)}`);
    printInfo(`  Public key: ${chalk.dim(newKp.publicKeyHex)}`);
    printInfo(`  Exported  → ${chalk.bold(path.relative(process.cwd(), pkPath))}`);
    if (reEncrypted > 0) {
      printInfo(`  Re-encrypted ${chalk.cyan(String(reEncrypted))} .secret file(s)`);
    } else {
      printInfo(`  ${chalk.dim("No .secret files found — nothing to re-encrypt")}`);
    }
    printInfo("");
    printInfo(chalk.bold("Recipients now:"));
    for (const r of keyRecords) {
      printInfo(`  ${chalk.cyan(r.name)}  ${chalk.dim(r.publicKey)}`);
    }
  }
}

/**
 * `secrets list` — show recipients in each .secret file.
 */
async function cmdSecretsList(): Promise<void> {
  const repoPath = await requireConfigRepo("secrets list");
  const secretPaths = await findSecretFiles(repoPath);

  if (secretPaths.length === 0) {
    if (jsonMode) {
      printJson({
        ok: true,
        subcommand: "secrets list",
        data: { files: [] },
      });
    } else {
      printInfo(chalk.dim("No .secret files found in repo."));
    }
    return;
  }

  const fileInfos: Array<{
    path: string;
    recipients: Array<{ name?: string; publicKey: string }>;
    error?: string;
  }> = [];

  for (const sp of secretPaths) {
    try {
      const content = await fs.readFile(sp, "utf-8");
      const ef = parseEncryptedFile(content);
      fileInfos.push({
        path: path.relative(repoPath, sp),
        recipients: ef.recipients.map((r) => ({
          ...(r.name !== undefined ? { name: r.name } : {}),
          publicKey: r.publicKey,
        })),
      });
    } catch (err: unknown) {
      fileInfos.push({
        path: path.relative(repoPath, sp),
        recipients: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (jsonMode) {
    printJson({
      ok: true,
      subcommand: "secrets list",
      data: { files: fileInfos },
    });
    return;
  }

  printInfo(chalk.bold(`${secretPaths.length} .secret file(s) in repo:`));
  printInfo("");
  for (const info of fileInfos) {
    if (info.error) {
      printInfo(`  ${chalk.yellow(info.path)}`);
      printInfo(`    ${chalk.red("Error: " + info.error)}`);
    } else {
      printInfo(`  ${chalk.cyan(info.path)}`);
      for (const r of info.recipients) {
        const label = r.name ? chalk.white(r.name) : chalk.dim("(unnamed)");
        printInfo(`    ${label}  ${chalk.dim(r.publicKey)}`);
      }
    }
    printInfo("");
  }
}

// ─── Secrets dispatch ─────────────────────────────────────────────────────────

async function cmdSecrets(
  subArgs: string[],
  keyFile: string,
): Promise<void> {
  const action = subArgs[0];

  switch (action) {
    case "add": {
      const sourcePath = subArgs[1];
      if (!sourcePath) {
        if (jsonMode) {
          printJson({
            ok: false,
            subcommand: "secrets add",
            error: "Missing required argument: <src>",
          });
        } else {
          printError(`Missing required argument: ${chalk.bold("<src>")}`);
          printInfo(
            `  Usage: ${chalk.cyan("npx tsx script/mqlti-config.ts secrets add <path>")}`,
          );
        }
        process.exit(1);
      }
      await cmdSecretsAdd(sourcePath, keyFile);
      break;
    }

    case "rotate": {
      await cmdSecretsRotate(keyFile);
      break;
    }

    case "list": {
      await cmdSecretsList();
      break;
    }

    default: {
      if (jsonMode) {
        printJson({
          ok: false,
          subcommand: "secrets",
          error: action
            ? `Unknown secrets action: ${action}`
            : "Missing secrets action (add|rotate|list)",
        });
      } else {
        if (action) {
          printError(`Unknown secrets action: ${chalk.bold(action)}`);
        } else {
          printError("Missing secrets action.");
        }
        printInfo(
          `  Usage: ${chalk.cyan("secrets add <src>")} | ${chalk.cyan("secrets rotate")} | ${chalk.cyan("secrets list")}`,
        );
      }
      process.exit(1);
    }
  }
}

// ─── Stub subcommands ─────────────────────────────────────────────────────────

type StubDef = {
  name: string;
  issueRef: string;
};

const STUBS: StubDef[] = [
  { name: "push", issueRef: "#319" },
  { name: "pull", issueRef: "#320" },
];

function runStub(name: string, issueRef: string): never {
  const message = `Not yet implemented — requires ${issueRef}`;
  if (jsonMode) {
    printJson({ ok: false, subcommand: name, error: message });
  } else {
    printWarn(`${chalk.bold(`mqlti config ${name}`)}: ${message}`);
  }
  process.exit(1);
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  subcommand: string | null;
  positional: string[];
  json: boolean;
  help: boolean;
  keyFile: string;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: null,
    positional: [],
    json: false,
    help: false,
    keyFile: DEFAULT_AGE_KEY_FILE,
    dryRun: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      result.json = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--key-file") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        result.keyFile = next;
        i++;
      }
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--force") {
      result.force = true;
    } else if (result.subcommand === null && !arg.startsWith("-")) {
      result.subcommand = arg;
    } else if (!arg.startsWith("-")) {
      result.positional.push(arg);
    }
  }

  return result;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** Recursively collect all .secret files under a directory. */
async function findSecretFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".secret")) {
        results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

/**
 * Append a line to .gitignore if it isn't already present.
 * The file is created if it doesn't exist.
 */
async function appendToGitignore(repoPath: string, line: string): Promise<void> {
  const gitignorePath = path.join(repoPath, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist yet — will be created
  }
  const lines = existing.split("\n");
  if (!lines.includes(line)) {
    const append = (existing.endsWith("\n") || existing === "" ? "" : "\n") + line + "\n";
    await fs.appendFile(gitignorePath, append, "utf-8");
  }
}

/** Derive a hostname-based machine label. */
function hostnameLabel(): string {
  return os.hostname().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}

/** Make a string safe for use as a filename (no slashes, colons, etc.). */
function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // argv[0] = node, argv[1] = script path
  const args = parseArgs(process.argv.slice(2));

  setJsonMode(args.json);

  // Help or no subcommand
  if (args.help || args.subcommand === null) {
    if (jsonMode) {
      printJson({
        ok: true,
        subcommand: "help",
        data: {
          subcommands: [
            "init",
            "status",
            "export",
            "apply",
            "diff",
            "push",
            "pull",
            "secrets",
          ],
          flags: ["--json", "--help", "--key-file"],
        },
      });
    } else {
      console.log(HELP_TEXT);
    }
    process.exit(args.subcommand === null && !args.help ? 1 : 0);
  }

  try {
    switch (args.subcommand) {
      case "init": {
        const targetPath = args.positional[0];
        if (!targetPath) {
          if (jsonMode) {
            printJson({
              ok: false,
              subcommand: "init",
              error: "Missing required argument: <path>",
            });
          } else {
            printError(`Missing required argument: ${chalk.bold("<path>")}`);
            printInfo(
              `  Usage: ${chalk.cyan("npx tsx script/mqlti-config.ts init <path>")}`,
            );
          }
          process.exit(1);
        }
        await cmdInit(targetPath);
        break;
      }

      case "status": {
        await cmdStatus();
        break;
      }

      case "export": {
        await cmdExport();
        break;
      }

      case "apply": {
        await cmdApply(args.dryRun, args.force);
        break;
      }

      case "diff": {
        await cmdDiff();
        break;
      }

      case "secrets": {
        await cmdSecrets(args.positional, args.keyFile);
        break;
      }

      default: {
        const stub = STUBS.find((s) => s.name === args.subcommand);
        if (stub) {
          runStub(stub.name, stub.issueRef);
        }
        if (jsonMode) {
          printJson({
            ok: false,
            subcommand: args.subcommand,
            error: `Unknown subcommand: ${args.subcommand}`,
          });
        } else {
          printError(`Unknown subcommand: ${chalk.bold(args.subcommand)}`);
          printInfo(
            `  Run ${chalk.cyan("npx tsx script/mqlti-config.ts --help")} for usage.`,
          );
        }
        process.exit(1);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      printJson({ ok: false, subcommand: args.subcommand ?? "", error: message });
    } else {
      printError(`Internal error: ${message}`);
    }
    process.exit(2);
  }
}

main();
