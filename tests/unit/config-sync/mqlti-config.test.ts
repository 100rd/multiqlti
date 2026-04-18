/**
 * Tests for script/mqlti-config.ts (issues #314, #315)
 *
 * Coverage:
 *   - init: creates correct directory structure, meta file, .gitignore, git repo
 *   - init: refuses to re-init an already-initialised repo
 *   - init: requires <path> argument, exits 1 without it
 *   - init --json: machine-readable output
 *   - status: reads meta file, shows git state
 *   - status --json: machine-readable output
 *   - status: exits 1 when no config repo found
 *   - stubs (export/apply/diff/push/pull): exit 1, print "Not yet implemented"
 *   - stubs --json: machine-readable error output
 *   - secrets add: encrypts a file for all recipients in public-keys/
 *   - secrets add: exits 1 when source file missing
 *   - secrets add: exits 1 when no public keys are present
 *   - secrets add --json: machine-readable output
 *   - secrets rotate: generates key + exports public key + re-encrypts .secret files
 *   - secrets rotate --json: machine-readable output
 *   - secrets list: lists recipients in each .secret file
 *   - secrets list --json: machine-readable output
 *   - secrets (no action): exits 1 with error
 *   - secrets <unknown-action>: exits 1 with error
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

import {
  generateKeyPair,
  serializeKeyPair,
  buildPublicKeyRecord,
  encrypt,
  serializeEncryptedFile,
} from "../../../server/config-sync/age-crypto.js";

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
    expect(json.data.subcommands).toContain("secrets");
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
    { name: "export", issue: "#316" },
    { name: "apply", issue: "#317" },
    { name: "diff", issue: "#318" },
    { name: "push", issue: "#319" },
    { name: "pull", issue: "#320" },
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

// ─── secrets ─────────────────────────────────────────────────────────────────

describe("secrets", () => {
  // Helper: init a config repo and return its path
  async function initRepo(): Promise<string> {
    const target = path.join(tmpDir, "repo");
    const { exitCode } = await runCli(["init", target]);
    expect(exitCode).toBe(0);
    return target;
  }

  // Helper: write a public key JSON for a given key pair into the repo
  async function writePublicKey(repoPath: string, name: string): Promise<string> {
    const kp = generateKeyPair(name);
    const record = buildPublicKeyRecord(kp);
    const pkPath = path.join(repoPath, "public-keys", `${name}.json`);
    await fs.writeFile(pkPath, JSON.stringify(record, null, 2));
    return kp.publicKeyHex;
  }

  // ─── secrets add ────────────────────────────────────────────────────────────

  describe("secrets add", () => {
    it("exits 1 when called outside a config repo", async () => {
      const srcFile = path.join(tmpDir, "test.yaml");
      await fs.writeFile(srcFile, "key: value");
      const { exitCode, stdout, stderr } = await runCli(
        ["secrets", "add", srcFile],
        tmpDir,
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toMatch(/no config repo/i);
    });

    it("exits 1 when source file does not exist", async () => {
      const repoPath = await initRepo();
      const { exitCode, stdout, stderr } = await runCli(
        ["secrets", "add", path.join(repoPath, "nonexistent.yaml")],
        repoPath,
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toMatch(/not found|source file/i);
    });

    it("exits 1 when no public keys are present", async () => {
      const repoPath = await initRepo();
      const srcFile = path.join(repoPath, "connections", "test.yaml");
      await fs.writeFile(srcFile, "token: secret123");

      const { exitCode, stdout, stderr } = await runCli(
        ["secrets", "add", srcFile],
        repoPath,
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toMatch(/no public keys/i);
    });

    it("encrypts a file and creates a .secret file", async () => {
      const repoPath = await initRepo();
      await writePublicKey(repoPath, "laptop-alice");

      const srcFile = path.join(repoPath, "connections", "gitlab.yaml");
      await fs.writeFile(srcFile, "api_key: supersecret\n");

      const { exitCode } = await runCli(
        ["secrets", "add", srcFile],
        repoPath,
      );
      expect(exitCode).toBe(0);

      const secretPath = srcFile + ".secret";
      await expect(fs.access(secretPath)).resolves.toBeUndefined();

      // Verify it's valid JSON with the expected structure
      const content = await fs.readFile(secretPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(1);
      expect(Array.isArray(parsed.recipients)).toBe(true);
      expect(parsed.recipients).toHaveLength(1);
      expect(parsed.recipients[0].name).toBe("laptop-alice");
    });

    it("adds source path to .gitignore", async () => {
      const repoPath = await initRepo();
      await writePublicKey(repoPath, "m1");

      const srcFile = path.join(repoPath, "connections", "secret.yaml");
      await fs.writeFile(srcFile, "token: abc");

      await runCli(["secrets", "add", srcFile], repoPath);

      const gitignore = await fs.readFile(
        path.join(repoPath, ".gitignore"),
        "utf-8",
      );
      expect(gitignore).toContain("connections/secret.yaml");
    });

    it("uses all recipients in public-keys/", async () => {
      const repoPath = await initRepo();
      await writePublicKey(repoPath, "alice");
      await writePublicKey(repoPath, "bob");

      const srcFile = path.join(repoPath, "connections", "multi.yaml");
      await fs.writeFile(srcFile, "data: value");

      const { exitCode } = await runCli(
        ["secrets", "add", srcFile],
        repoPath,
      );
      expect(exitCode).toBe(0);

      const content = await fs.readFile(srcFile + ".secret", "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.recipients).toHaveLength(2);
    });

    it("secrets add --json returns structured success", async () => {
      const repoPath = await initRepo();
      await writePublicKey(repoPath, "m1");

      const srcFile = path.join(repoPath, "connections", "s.yaml");
      await fs.writeFile(srcFile, "key: val");

      const { exitCode, stdout } = await runCli(
        ["secrets", "add", srcFile, "--json"],
        repoPath,
      );
      expect(exitCode).toBe(0);
      const json = JSON.parse(stdout);
      expect(json.ok).toBe(true);
      expect(json.subcommand).toBe("secrets add");
      expect(json.data.source).toBe(srcFile);
      expect(json.data.secret).toBe(srcFile + ".secret");
      expect(Array.isArray(json.data.recipients)).toBe(true);
      expect(json.data.recipients).toHaveLength(1);
    });

    it("exits 1 when source path arg is missing", async () => {
      const repoPath = await initRepo();
      const { exitCode, stdout, stderr } = await runCli(
        ["secrets", "add"],
        repoPath,
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toMatch(/missing.*argument|<src>/i);
    });
  });

  // ─── secrets rotate ──────────────────────────────────────────────────────────

  describe("secrets rotate", () => {
    it("exits 1 when called outside a config repo", async () => {
      const keyFile = path.join(tmpDir, "age-keys.txt");
      const { exitCode, stdout, stderr } = await runCli(
        ["secrets", "rotate", "--key-file", keyFile],
        tmpDir,
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toMatch(/no config repo/i);
    });

    it("generates a key file at --key-file path", async () => {
      const repoPath = await initRepo();
      const keyFile = path.join(tmpDir, "my-age-keys.txt");

      const { exitCode } = await runCli(
        ["secrets", "rotate", "--key-file", keyFile],
        repoPath,
      );
      expect(exitCode).toBe(0);

      await expect(fs.access(keyFile)).resolves.toBeUndefined();
      const content = await fs.readFile(keyFile, "utf-8");
      expect(content).toContain("private:");
      expect(content).toContain("public-key:");
    });

    it("writes a public key JSON file to public-keys/", async () => {
      const repoPath = await initRepo();
      const keyFile = path.join(tmpDir, "age-keys.txt");

      await runCli(
        ["secrets", "rotate", "--key-file", keyFile],
        repoPath,
      );

      const pkFiles = await fs.readdir(path.join(repoPath, "public-keys"));
      const jsonFiles = pkFiles.filter((f) => f.endsWith(".json"));
      expect(jsonFiles).toHaveLength(1);

      const pkContent = await fs.readFile(
        path.join(repoPath, "public-keys", jsonFiles[0]!),
        "utf-8",
      );
      const pkRecord = JSON.parse(pkContent);
      expect(pkRecord.version).toBe(1);
      expect(typeof pkRecord.publicKey).toBe("string");
      expect(pkRecord.publicKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it("re-encrypts existing .secret files", async () => {
      const repoPath = await initRepo();

      // Create a pre-existing key pair that is already a recipient in the secrets.
      const preKp = generateKeyPair("pre-existing");
      const preRecord = buildPublicKeyRecord(preKp);
      await fs.writeFile(
        path.join(repoPath, "public-keys", "pre.json"),
        JSON.stringify(preRecord),
      );

      const srcContent = Buffer.from("my secret data");
      const ef = encrypt(srcContent, [{ publicKey: preKp.publicKeyHex }]);
      const secretPath = path.join(repoPath, "connections", "test.secret");
      await fs.writeFile(secretPath, serializeEncryptedFile(ef));

      // Write the pre-existing private key to the key file so that rotate can
      // use it to decrypt the existing .secret files before rotating.
      const keyFile = path.join(tmpDir, "rotate-age-keys.txt");
      await fs.mkdir(path.dirname(keyFile), { recursive: true });
      await fs.writeFile(keyFile, serializeKeyPair(preKp), { mode: 0o600 });

      // Rotate — loads old key, generates new key, re-encrypts all secrets.
      const { exitCode } = await runCli(
        ["secrets", "rotate", "--key-file", keyFile],
        repoPath,
      );
      expect(exitCode).toBe(0);

      // The .secret file should now have 2 recipients (old + new)
      const updatedContent = await fs.readFile(secretPath, "utf-8");
      const parsed = JSON.parse(updatedContent);
      expect(parsed.recipients).toHaveLength(2);
    });

    it("secrets rotate --json returns structured success", async () => {
      const repoPath = await initRepo();
      const keyFile = path.join(tmpDir, "age-keys.txt");

      const { exitCode, stdout } = await runCli(
        ["secrets", "rotate", "--key-file", keyFile, "--json"],
        repoPath,
      );
      expect(exitCode).toBe(0);
      const json = JSON.parse(stdout);
      expect(json.ok).toBe(true);
      expect(json.subcommand).toBe("secrets rotate");
      expect(typeof json.data.publicKey).toBe("string");
      expect(json.data.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(json.data.recipients)).toBe(true);
      expect(typeof json.data.reEncryptedCount).toBe("number");
    });
  });

  // ─── secrets list ────────────────────────────────────────────────────────────

  describe("secrets list", () => {
    it("exits 1 when called outside a config repo", async () => {
      const { exitCode, stdout, stderr } = await runCli(
        ["secrets", "list"],
        tmpDir,
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toMatch(/no config repo/i);
    });

    it("prints 'no .secret files' when repo has none", async () => {
      const repoPath = await initRepo();
      const { exitCode, stdout } = await runCli(
        ["secrets", "list"],
        repoPath,
      );
      expect(exitCode).toBe(0);
      expect(stdout.toLowerCase()).toMatch(/no .secret files/i);
    });

    it("lists recipients from each .secret file", async () => {
      const repoPath = await initRepo();
      const kp = generateKeyPair("alice");
      const record = buildPublicKeyRecord(kp);

      // Write a .secret file manually
      const ef = encrypt(Buffer.from("secret data"), [
        { publicKey: kp.publicKeyHex, name: "alice" },
      ]);
      await fs.writeFile(
        path.join(repoPath, "connections", "test.secret"),
        serializeEncryptedFile(ef),
      );

      const { exitCode, stdout } = await runCli(
        ["secrets", "list"],
        repoPath,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("alice");
      expect(stdout).toContain(kp.publicKeyHex);
      void record; // suppress unused warning
    });

    it("secrets list --json returns structured output", async () => {
      const repoPath = await initRepo();
      const kp = generateKeyPair("bob");
      const ef = encrypt(Buffer.from("data"), [
        { publicKey: kp.publicKeyHex, name: "bob" },
      ]);
      await fs.writeFile(
        path.join(repoPath, "connections", "bob.secret"),
        serializeEncryptedFile(ef),
      );

      const { exitCode, stdout } = await runCli(
        ["secrets", "list", "--json"],
        repoPath,
      );
      expect(exitCode).toBe(0);
      const json = JSON.parse(stdout);
      expect(json.ok).toBe(true);
      expect(json.subcommand).toBe("secrets list");
      expect(Array.isArray(json.data.files)).toBe(true);
      expect(json.data.files).toHaveLength(1);
      expect(json.data.files[0].recipients).toHaveLength(1);
      expect(json.data.files[0].recipients[0].name).toBe("bob");
    });

    it("secrets list --json empty repo returns empty files array", async () => {
      const repoPath = await initRepo();
      const { exitCode, stdout } = await runCli(
        ["secrets", "list", "--json"],
        repoPath,
      );
      expect(exitCode).toBe(0);
      const json = JSON.parse(stdout);
      expect(json.ok).toBe(true);
      expect(json.data.files).toHaveLength(0);
    });
  });

  // ─── secrets bad actions ─────────────────────────────────────────────────────

  describe("secrets error cases", () => {
    it("exits 1 when no action is given", async () => {
      const repoPath = await initRepo();
      const { exitCode, stdout, stderr } = await runCli(
        ["secrets"],
        repoPath,
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toMatch(/missing secrets action|add.*rotate.*list/i);
    });

    it("exits 1 for unknown action", async () => {
      const repoPath = await initRepo();
      const { exitCode, stdout, stderr } = await runCli(
        ["secrets", "bogus"],
        repoPath,
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toMatch(/unknown secrets action/i);
    });

    it("secrets --json exits 1 with structured error when action missing", async () => {
      const repoPath = await initRepo();
      const { exitCode, stdout } = await runCli(
        ["secrets", "--json"],
        repoPath,
      );
      expect(exitCode).toBe(1);
      const json = JSON.parse(stdout);
      expect(json.ok).toBe(false);
      expect(json.subcommand).toBe("secrets");
    });
  });
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
