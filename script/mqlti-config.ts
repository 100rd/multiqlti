#!/usr/bin/env tsx
/**
 * mqlti config — Config-sync CLI subcommand
 *
 * Usage:
 *   npx tsx script/mqlti-config.ts <subcommand> [options]
 *   npx tsx script/mqlti-config.ts --help
 *
 * Subcommands:
 *   init <path>   Create a new config-sync repository
 *   status        Show sync state and git status
 *   export        [stub] Export live config to YAML files
 *   apply         [stub] Apply YAML files to running instance
 *   diff          [stub] Show diff between local YAML and live config
 *   push          [stub] Push local changes to remote git
 *   pull          [stub] Pull remote changes and apply
 *   secrets       [stub] Manage secret references
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
import path from "path";
import { existsSync } from "fs";
import simpleGit from "simple-git";
import yaml from "js-yaml";
import chalk from "chalk";

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
  ${chalk.cyan("init <path>")}     Create a config-sync repository at <path>
  ${chalk.cyan("status")}          Show git state and sync timestamps
  ${chalk.cyan("export")}          Export live config to YAML (requires #315)
  ${chalk.cyan("apply")}           Apply YAML to running instance (requires #316)
  ${chalk.cyan("diff")}            Diff local YAML vs live config (requires #317)
  ${chalk.cyan("push")}            Push local changes to remote git (requires #318)
  ${chalk.cyan("pull")}            Pull remote changes and apply (requires #319)
  ${chalk.cyan("secrets")}         Manage secret references (requires #320)

${chalk.bold("Options:")}
  ${chalk.yellow("--json")}           Output machine-readable JSON
  ${chalk.yellow("--help, -h")}       Show this help message

${chalk.bold("Exit codes:")}
  0   Success
  1   User error (bad arguments, bad state)
  2   Internal error (unexpected exception)

${chalk.bold("Examples:")}
  npx tsx script/mqlti-config.ts init ./my-config-repo
  npx tsx script/mqlti-config.ts status
  npx tsx script/mqlti-config.ts status --json
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
  const content = [
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
  const gitignoreContent = [
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
        error:
          "No config repo found. Run `mqlti config init <path>` to create one.",
      });
    } else {
      printError("No config repo found in current directory or any parent.");
      printInfo(
        `  Run ${chalk.cyan("mqlti config init <path>")} to create one.`,
      );
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
    if (gitInfo.ahead > 0)
      parts.push(chalk.cyan(`↑${gitInfo.ahead} ahead`));
    if (gitInfo.behind > 0)
      parts.push(chalk.yellow(`↓${gitInfo.behind} behind`));
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

// ─── Stub subcommands ─────────────────────────────────────────────────────────

type StubDef = {
  name: string;
  issueRef: string;
};

const STUBS: StubDef[] = [
  { name: "export", issueRef: "#315" },
  { name: "apply", issueRef: "#316" },
  { name: "diff", issueRef: "#317" },
  { name: "push", issueRef: "#318" },
  { name: "pull", issueRef: "#319" },
  { name: "secrets", issueRef: "#320" },
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
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    subcommand: null,
    positional: [],
    json: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--json") {
      result.json = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (result.subcommand === null && !arg.startsWith("-")) {
      result.subcommand = arg;
    } else if (!arg.startsWith("-")) {
      result.positional.push(arg);
    }
  }

  return result;
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
          subcommands: ["init", "status", "export", "apply", "diff", "push", "pull", "secrets"],
          flags: ["--json", "--help"],
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
            printError(
              `Missing required argument: ${chalk.bold("<path>")}`,
            );
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
