/**
 * Tests for script/mqlti-config.ts (issue #314)
 *
 * Coverage:
 *   - init: creates correct directory structure, meta file, .gitignore, git repo
 *   - init: refuses to re-init an already-initialised repo
 *   - init: requires <path> argument, exits 1 without it
 *   - init --json: machine-readable output
 *   - status: reads meta file, shows git state
 *   - status --json: machine-readable output
 *   - status: exits 1 when no config repo found
 *   - stubs: exit 1, print "Not yet implemented — requires #NNN"
 *   - stubs --json: machine-readable error output
 *   - unknown subcommand: exits 1
 *   - --help / no args: shows usage, exits 0 / 1 respectively
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

const SCRIPT = path.resolve(
  __dirname,
  "../../../script/mqlti-config.ts",
);

// ─── Runner helpers ───────────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  cwd?: string,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "npx",
      ["tsx", SCRIPT, ...args],
      {
        cwd: cwd ?? os.tmpdir(),
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

// ─── Temp directory management ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mqlti-test-")));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── help / no-args ───────────────────────────────────────────────────────────

describe("help and no-args", () => {
  it("exits 0 and prints usage when --help is passed", async () => {
    const { exitCode, stdout } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("mqlti config");
    expect(stdout).toContain("init");
    expect(stdout).toContain("status");
  });

  it("exits 0 and prints usage when -h is passed", async () => {
    const { exitCode, stdout } = await runCli(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("exits 1 when no subcommand is given", async () => {
    const { exitCode, stdout } = await runCli([]);
    expect(exitCode).toBe(1);
    // Still prints help
    expect(stdout).toContain("mqlti config");
  });

  it("--help --json returns structured JSON with subcommand list", async () => {
    const { exitCode, stdout } = await runCli(["--help", "--json"]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.ok).toBe(true);
    expect(json.subcommand).toBe("help");
    expect(json.data.subcommands).toContain("init");
    expect(json.data.subcommands).toContain("status");
  });
});

// ─── init ─────────────────────────────────────────────────────────────────────

describe("init", () => {
  it("creates the target directory if it does not exist", async () => {
    const target = path.join(tmpDir, "new-repo");
    const { exitCode } = await runCli(["init", target]);
    expect(exitCode).toBe(0);
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates all entity subdirectories", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);

    const expectedDirs = [
      "pipelines",
      "triggers",
      "connections",
      "provider-keys",
      "prompts",
      "skill-states",
      "preferences",
      "public-keys",
    ];
    for (const dir of expectedDirs) {
      const stat = await fs.stat(path.join(target, dir));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it("places a .gitkeep in every entity directory", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);

    for (const dir of ["pipelines", "triggers", "public-keys"]) {
      const keepPath = path.join(target, dir, ".gitkeep");
      await expect(fs.access(keepPath)).resolves.toBeUndefined();
    }
  });

  it("creates .mqlti-config.yaml with correct schema version", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);

    const metaRaw = await fs.readFile(
      path.join(target, ".mqlti-config.yaml"),
      "utf-8",
    );
    expect(metaRaw).toContain("schemaVersion: 1.0.0");
    expect(metaRaw).toContain("createdAt:");
    expect(metaRaw).toContain("lastExportAt: null");
    expect(metaRaw).toContain("lastApplyAt: null");
    expect(metaRaw).toContain("lastPushAt: null");
    expect(metaRaw).toContain("lastPullAt: null");
  });

  it("creates .gitignore that blocks secret files", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);

    const gitignore = await fs.readFile(
      path.join(target, ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("*.secret");
    expect(gitignore).toContain("*.key");
    expect(gitignore).toContain(".env");
  });

  it("initialises a git repository (.git directory exists)", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);

    const gitDir = path.join(target, ".git");
    const stat = await fs.stat(gitDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("exits 0 and prints success message", async () => {
    const target = path.join(tmpDir, "repo");
    const { exitCode, stdout } = await runCli(["init", target]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/config repo/i);
  });

  it("exits 1 when called without a path argument", async () => {
    const { exitCode, stderr, stdout } = await runCli(["init"]);
    expect(exitCode).toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/missing.*argument|<path>/i);
  });

  it("exits 1 and errors when the repo is already initialised", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);
    const { exitCode, stdout, stderr } = await runCli(["init", target]);
    expect(exitCode).toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/already initialised/i);
  });

  it("init --json returns structured success JSON", async () => {
    const target = path.join(tmpDir, "repo");
    const { exitCode, stdout } = await runCli(["init", target, "--json"]);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.ok).toBe(true);
    expect(json.subcommand).toBe("init");
    expect(json.data.path).toBe(target);
    expect(Array.isArray(json.data.entityDirs)).toBe(true);
    expect(json.data.entityDirs).toContain("pipelines");
    expect(json.data.entityDirs).toContain("triggers");
    expect(json.data.metaFile).toBe(".mqlti-config.yaml");
    expect(typeof json.data.createdAt).toBe("string");
  });

  it("init --json exits 1 with error JSON when path missing", async () => {
    const { exitCode, stdout } = await runCli(["init", "--json"]);
    expect(exitCode).toBe(1);
    const json = JSON.parse(stdout);
    expect(json.ok).toBe(false);
    expect(json.subcommand).toBe("init");
    expect(typeof json.error).toBe("string");
  });

  it("init --json exits 1 with error JSON when already initialised", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);
    const { exitCode, stdout } = await runCli(["init", target, "--json"]);
    expect(exitCode).toBe(1);
    const json = JSON.parse(stdout);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/already initialised/i);
  });
});

// ─── status ───────────────────────────────────────────────────────────────────

describe("status", () => {
  it("exits 1 with error when no config repo is found", async () => {
    // Run from an empty tmpDir with no .mqlti-config.yaml
    const { exitCode, stdout, stderr } = await runCli(["status"], tmpDir);
    expect(exitCode).toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/no config repo/i);
  });

  it("exits 0 and shows repo path after init", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);
    const { exitCode, stdout } = await runCli(["status"], target);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(target);
  });

  it("shows git branch info after init", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);
    const { exitCode, stdout } = await runCli(["status"], target);
    expect(exitCode).toBe(0);
    // Either shows branch name or "(no commits yet)"
    expect(stdout).toMatch(/branch|no commits/i);
  });

  it("shows sync timestamps (all null after init)", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);
    const { stdout } = await runCli(["status"], target);
    expect(stdout).toContain("Last export:");
    expect(stdout).toContain("Last apply:");
    expect(stdout).toContain("Last push:");
    expect(stdout).toContain("Last pull:");
    // All should show "never" since no sync has occurred
    expect(stdout).toMatch(/never/i);
  });

  it("status --json returns structured JSON", async () => {
    const target = path.join(tmpDir, "repo");
    await runCli(["init", target]);
    const { exitCode, stdout } = await runCli(["status", "--json"], target);
    expect(exitCode).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.ok).toBe(true);
    expect(json.subcommand).toBe("status");
    expect(json.data.repoPath).toBe(target);
    expect(typeof json.data.git.branch).toBe("string");
    expect(typeof json.data.git.dirty).toBe("boolean");
    expect(typeof json.data.git.ahead).toBe("number");
    expect(typeof json.data.git.behind).toBe("number");
    expect(json.data.sync.lastExportAt).toBeNull();
    expect(json.data.sync.lastApplyAt).toBeNull();
    expect(json.data.sync.lastPushAt).toBeNull();
    expect(json.data.sync.lastPullAt).toBeNull();
    expect(json.data.meta.schemaVersion).toBe("1.0.0");
    expect(typeof json.data.meta.createdAt).toBe("string");
  });

  it("status --json exits 1 with error JSON when no repo found", async () => {
    const { exitCode, stdout } = await runCli(["status", "--json"], tmpDir);
    expect(exitCode).toBe(1);
    const json = JSON.parse(stdout);
    expect(json.ok).toBe(false);
    expect(json.subcommand).toBe("status");
    expect(typeof json.error).toBe("string");
    expect(json.error).toMatch(/no config repo/i);
  });
});

// ─── Stub subcommands ─────────────────────────────────────────────────────────

describe("stub subcommands", () => {
  const stubs = [
    { name: "export", issue: "#315" },
    { name: "apply", issue: "#316" },
    { name: "diff", issue: "#317" },
    { name: "push", issue: "#318" },
    { name: "pull", issue: "#319" },
    { name: "secrets", issue: "#320" },
  ] as const;

  for (const { name, issue } of stubs) {
    it(`${name}: exits 1 and prints "Not yet implemented — requires ${issue}"`, async () => {
      const { exitCode, stdout, stderr } = await runCli([name]);
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toContain("Not yet implemented");
      expect(combined).toContain(issue);
    });

    it(`${name} --json: exits 1 with structured JSON error`, async () => {
      const { exitCode, stdout } = await runCli([name, "--json"]);
      expect(exitCode).toBe(1);
      const json = JSON.parse(stdout);
      expect(json.ok).toBe(false);
      expect(json.subcommand).toBe(name);
      expect(json.error).toContain("Not yet implemented");
      expect(json.error).toContain(issue);
    });
  }
});

// ─── Unknown subcommand ───────────────────────────────────────────────────────

describe("unknown subcommand", () => {
  it("exits 1 and prints error for unknown subcommand", async () => {
    const { exitCode, stdout, stderr } = await runCli(["nonexistent"]);
    expect(exitCode).toBe(1);
    const combined = stdout + stderr;
    expect(combined).toMatch(/unknown subcommand/i);
  });

  it("unknown --json: exits 1 with structured JSON error", async () => {
    const { exitCode, stdout } = await runCli(["nonexistent", "--json"]);
    expect(exitCode).toBe(1);
    const json = JSON.parse(stdout);
    expect(json.ok).toBe(false);
    expect(json.subcommand).toBe("nonexistent");
    expect(json.error).toMatch(/unknown subcommand/i);
  });
});

// ─── Exit code contract ───────────────────────────────────────────────────────

describe("exit code contract", () => {
  it("init success → exit 0", async () => {
    const target = path.join(tmpDir, "exit-code-test");
    const { exitCode } = await runCli(["init", target]);
    expect(exitCode).toBe(0);
  });

  it("init without path → exit 1 (user error)", async () => {
    const { exitCode } = await runCli(["init"]);
    expect(exitCode).toBe(1);
  });

  it("status without repo → exit 1 (user error)", async () => {
    const { exitCode } = await runCli(["status"], tmpDir);
    expect(exitCode).toBe(1);
  });

  it("stub subcommand → exit 1 (user error, not yet implemented)", async () => {
    const { exitCode } = await runCli(["export"]);
    expect(exitCode).toBe(1);
  });

  it("unknown subcommand → exit 1", async () => {
    const { exitCode } = await runCli(["bogus"]);
    expect(exitCode).toBe(1);
  });
});
