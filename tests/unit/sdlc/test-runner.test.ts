/**
 * test-runner.test.ts — Stage 2b: the SANDBOXED subprocess test runner (the security
 * focal point). Every spawn is mocked — NO real subprocess runs.
 *
 * Asserts the BINDING security properties the veto reviewer keys off:
 *   - COMMAND SOURCE = config/package.json, NEVER untrusted text (resolution order +
 *     the fixed `npm test` argv for the package.json path).
 *   - NO SHELL: spawn gets an ARG ARRAY + `shell: false`.
 *   - ENV ALLOWLIST (fail-closed): secrets / GH/AWS tokens / claude auth dropped.
 *   - HARD TIMEOUT → SIGKILL on a wedged child.
 *   - OUTPUT CLAMP + fs-path SCRUB on the surfaced summary.
 *   - DEGRADE-not-throw: spawn error / non-zero exit / missing command ⇒ passed:false.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  runTests,
  verifyInWorktree,
  resolveTestCommand,
  parseConfiguredCommand,
  detectPackageJsonTest,
  sanitizedTestEnv,
  TEST_ENV_ALLOWLIST,
  type ResolvedTestCommand,
  type TestSpawnFn,
  type TestChildProcess,
} from "../../../server/services/sdlc/test-runner.js";

const WT = "/tmp/sdlc-wt-XXXX/tree";
const CMD: ResolvedTestCommand = { binary: "npm", args: ["test", "--silent"], source: "config" };

interface SpawnScript {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  emitError?: Error;
  /** Never self-close — only a kill() ends it (timeout path). */
  hang?: boolean;
  /** Throw synchronously from spawn (e.g. a bad binary). */
  throwOnSpawn?: Error;
}

function makeSpawn(script: SpawnScript) {
  const calls: Array<{ binary: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const kills: string[] = [];
  const fn: TestSpawnFn = (binary, args, options) => {
    calls.push({ binary, args, options: options as unknown as Record<string, unknown> });
    if (script.throwOnSpawn) throw script.throwOnSpawn;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & TestChildProcess;
    let closed = false;
    (child as unknown as { pid: number }).pid = 4242; // stable fake pid for group-kill asserts
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = stderr;
    (child as unknown as { kill: (s?: string) => boolean }).kill = (sig?: string) => {
      kills.push(sig ?? "SIGTERM");
      if (!closed) {
        closed = true;
        child.emit("close", null, sig ?? null); // killed → close synchronously
      }
      return true;
    };
    // Emit the scripted output + close AFTER the runner attaches its listeners.
    setImmediate(() => {
      if (script.emitError) {
        child.emit("error", script.emitError);
        return;
      }
      if (script.stdout) stdout.emit("data", Buffer.from(script.stdout));
      if (script.stderr) stderr.emit("data", Buffer.from(script.stderr));
      if (!script.hang && !closed) {
        closed = true;
        child.emit("close", script.code ?? 0, null);
      }
    });
    return child;
  };
  return { fn, calls, kills };
}

afterEach(() => vi.useRealTimers());

// ─── command source resolution (config/package.json — NEVER untrusted text) ──

describe("resolveTestCommand — source is config or package.json, never AP text", () => {
  it("parseConfiguredCommand tokenizes the OPERATOR command into argv (no shell)", () => {
    expect(parseConfiguredCommand("npm test")).toEqual({ binary: "npm", args: ["test"], source: "config" });
    expect(parseConfiguredCommand("  pnpm   run   test  ")).toEqual({
      binary: "pnpm",
      args: ["run", "test"],
      source: "config",
    });
    expect(parseConfiguredCommand("")).toBeNull();
    expect(parseConfiguredCommand("   ")).toBeNull();
    expect(parseConfiguredCommand(null)).toBeNull();
    expect(parseConfiguredCommand(undefined)).toBeNull();
  });

  it("detectPackageJsonTest runs `npm test` as FIXED argv (never reads the script into a shell)", async () => {
    const readFileFn = vi.fn(async () => JSON.stringify({ scripts: { test: "vitest run && echo done" } }));
    const cmd = await detectPackageJsonTest(WT, readFileFn);
    expect(cmd).toEqual({ binary: "npm", args: ["test", "--silent"], source: "package-json" });
    // The actual script string ("&&", "echo") is NEVER surfaced into argv — npm runs it.
    expect(cmd?.args.join(" ")).not.toContain("&&");
    expect(cmd?.args.join(" ")).not.toContain("echo");
  });

  it("detectPackageJsonTest returns null for the npm placeholder / missing / unparseable", async () => {
    const placeholder = vi.fn(async () => JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(await detectPackageJsonTest(WT, placeholder)).toBeNull();
    const noScript = vi.fn(async () => JSON.stringify({ name: "x" }));
    expect(await detectPackageJsonTest(WT, noScript)).toBeNull();
    const bad = vi.fn(async () => "{not json");
    expect(await detectPackageJsonTest(WT, bad)).toBeNull();
    const missing = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    expect(await detectPackageJsonTest(WT, missing)).toBeNull();
  });

  it("config testCommand OVERRIDES package.json auto-detect", async () => {
    const readFileFn = vi.fn(async () => JSON.stringify({ scripts: { test: "vitest" } }));
    const cmd = await resolveTestCommand(WT, "make check", { readFileFn });
    expect(cmd).toEqual({ binary: "make", args: ["check"], source: "config" });
    expect(readFileFn).not.toHaveBeenCalled(); // config short-circuits the fs read.
  });

  it("falls through to package.json when no config command is set", async () => {
    const readFileFn = vi.fn(async () => JSON.stringify({ scripts: { test: "vitest run" } }));
    const cmd = await resolveTestCommand(WT, null, { readFileFn });
    expect(cmd?.source).toBe("package-json");
  });
});

// ─── no-shell argv spawn ──────────────────────────────────────────────────────

describe("runTests — no-shell argv spawn", () => {
  it("spawns with an ARG ARRAY, shell:false, cwd=worktree, ignored stdin", async () => {
    const { fn, calls } = makeSpawn({ stdout: "ok", code: 0 });
    await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("npm");
    expect(calls[0].args).toEqual(["test", "--silent"]);
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].options.detached).toBe(true); // MED-1: own process group
    expect(calls[0].options.cwd).toBe(WT);
    expect(calls[0].options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});

// ─── env allowlist (fail-closed) ──────────────────────────────────────────────

describe("env allowlist — no secrets reach the test process", () => {
  it("sanitizedTestEnv keeps only OS/runtime keys; drops every secret + claude auth", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      LANG: "en_US.UTF-8",
      // Everything below MUST be dropped (fail-closed allowlist):
      POSTGRES_PASSWORD: "hunter2",
      GH_TOKEN: "ghp_xxx",
      GITHUB_TOKEN: "ghp_yyy",
      AWS_SECRET_ACCESS_KEY: "aws",
      ANTHROPIC_API_KEY: "sk-ant",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth", // claude auth — test process needs no model auth
      CLAUDE_CONFIG_DIR: "/cfg",
      SOME_SECRET: "nope",
    };
    const env = sanitizedTestEnv(source);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.LANG).toBe("en_US.UTF-8");
    for (const leaked of [
      "POSTGRES_PASSWORD",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "SOME_SECRET",
    ]) {
      expect(env[leaked]).toBeUndefined();
    }
  });

  it("the test allowlist is a STRICTER subset of the coder allowlist (no CLAUDE_* keys)", () => {
    expect(TEST_ENV_ALLOWLIST).toContain("PATH");
    expect(TEST_ENV_ALLOWLIST.some((k) => k.startsWith("CLAUDE_"))).toBe(false);
  });

  it("the spawned child receives ONLY the provided allowlisted env", async () => {
    const { fn, calls } = makeSpawn({ code: 0 });
    const env = { PATH: "/usr/bin", HOME: "/h" };
    await runTests({ worktreeDir: WT, command: CMD, env, spawnFn: fn });
    expect(calls[0].options.env).toEqual(env);
    expect((calls[0].options.env as NodeJS.ProcessEnv).GH_TOKEN).toBeUndefined();
  });
});

// ─── hard timeout → SIGKILL ───────────────────────────────────────────────────

describe("runTests — hard timeout → SIGKILL the PROCESS GROUP (MED-1)", () => {
  it("spawns detached and, on timeout, group-kills the NEGATIVE pid (reaps forked workers)", async () => {
    vi.useFakeTimers();
    const { fn, kills, calls } = makeSpawn({ hang: true });
    const killGroupFn = vi.fn();
    const p = runTests({ worktreeDir: WT, command: CMD, timeoutMs: 10_000, spawnFn: fn, killGroupFn });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    // The child is its own process-group leader.
    expect(calls[0].options.detached).toBe(true);
    // The GROUP is killed by pid (the seam negates it to -pid internally).
    expect(killGroupFn).toHaveBeenCalledWith(4242);
    // The direct child is also signalled (belt-and-suspenders) and the run is timedOut.
    expect(kills).toContain("SIGKILL");
    expect(res.timedOut).toBe(true);
    expect(res.passed).toBe(false);
    // The summary is ACTIONABLE + NOT-ADJUDICATED: it names the configured cap and both
    // hypotheses (slow suite vs hang) and states the policy (fix loop skipped). ran stays
    // true (the process DID run — unlike a launch failure).
    expect(res.summary).toMatch(/TIMED OUT after 10000ms/);
    expect(res.summary).toMatch(/exceed testRunTimeoutMs/);
    expect(res.summary).toMatch(/introduced a hang/);
    expect(res.summary).toMatch(/not adjudicated, fix loop skipped/);
    expect(res.ran).toBe(true);
  });

  it("the DEFAULT killGroup targets the NEGATIVE pid via process.kill (the whole group)", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { fn } = makeSpawn({ hang: true });
    const p = runTests({ worktreeDir: WT, command: CMD, timeoutMs: 10_000, spawnFn: fn });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    // process.kill(-pid, "SIGKILL") — negative pid = the process group.
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
    killSpy.mockRestore();
  });

  it("a group-kill throw (group already gone) is swallowed; the run still settles timedOut", async () => {
    vi.useFakeTimers();
    const { fn } = makeSpawn({ hang: true });
    const killGroupFn = vi.fn(() => {
      throw new Error("ESRCH");
    });
    const p = runTests({ worktreeDir: WT, command: CMD, timeoutMs: 10_000, spawnFn: fn, killGroupFn });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(res.timedOut).toBe(true);
  });
});

// ─── output clamp + scrub ─────────────────────────────────────────────────────

describe("runTests — output clamp + fs-path scrub", () => {
  it("scrubs absolute fs paths out of the surfaced summary", async () => {
    const { fn } = makeSpawn({ stdout: "FAIL at /Users/secret/app/server/x.ts:42\n", code: 1 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.passed).toBe(false);
    expect(res.summary).not.toContain("/Users/secret");
    expect(res.summary).toContain("<path>");
  });

  it("clamps a huge output flood (bounded memory) and marks it truncated", async () => {
    const { fn } = makeSpawn({ stdout: "x".repeat(5_000_000), code: 1, stderr: "more" });
    const res = await runTests({ worktreeDir: WT, command: CMD, maxBuffer: 4096, spawnFn: fn });
    expect(res.summary.length).toBeLessThanOrEqual(4_000);
    expect(res.summary).toContain("[output truncated]");
  });
});

// ─── degrade-not-throw ────────────────────────────────────────────────────────

describe("runTests / verifyInWorktree — degrade, never throw", () => {
  it("a non-zero exit ⇒ passed:false (NOT a throw — a failing test is a normal signal)", async () => {
    const { fn } = makeSpawn({ stdout: "1 failing", code: 1 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.passed).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.ran).toBe(true);
    expect(res.summary).toMatch(/FAILED/);
  });

  it("exit 0 ⇒ passed:true", async () => {
    const { fn } = makeSpawn({ stdout: "all good", code: 0 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.passed).toBe(true);
    expect(res.summary).toMatch(/PASSED/);
  });

  it("a spawn 'error' event ⇒ passed:false, never throws", async () => {
    const { fn } = makeSpawn({ emitError: new Error("ENOENT npm") });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.passed).toBe(false);
    expect(res.exitCode).toBeNull();
  });

  it("a LAUNCH failure (spawn ENOENT — binary not found) ⇒ ran:false + an env-error summary", async () => {
    // The reported bug: `uv` not installed ⇒ Node emits an 'error' event with
    // code:'ENOENT'. The child NEVER executed, so ran MUST be false (indistinguishable-
    // from-a-test-failure was the bug) and the summary must read as an ENV problem.
    const err = Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" });
    const { fn } = makeSpawn({ emitError: err });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.passed).toBe(false);
    expect(res.ran).toBe(false); // ← could NOT run; not a test failure
    expect(res.exitCode).toBeNull();
    expect(res.summary).toMatch(/could not be launched/i);
    expect(res.summary).toMatch(/spawn uv ENOENT/);
    expect(res.summary).toMatch(/fix the environment or config testCommand/);
  });

  it("a LAUNCH failure (spawn EACCES — not executable) ⇒ ran:false", async () => {
    const err = Object.assign(new Error("spawn ./x EACCES"), { code: "EACCES" });
    const { fn } = makeSpawn({ emitError: err });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(false);
    expect(res.summary).toMatch(/could not be launched/i);
  });

  it("a POST-LAUNCH error event (no launch errno) ⇒ ran:true (the child DID start)", async () => {
    // An 'error' event WITHOUT ENOENT/EACCES fires only after the child started (e.g.
    // an I/O error mid-run). It ran ⇒ ran:true, NEVER misclassified as an env error —
    // the STRICT spawn-level rule is what protects a legitimate harness crash.
    const err = Object.assign(new Error("read EIO"), { code: "EIO" });
    const { fn } = makeSpawn({ emitError: err });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(true);
    expect(res.summary).not.toMatch(/could not be launched/i);
  });

  it("a synchronous spawn throw ⇒ passed:false, ran:false", async () => {
    const { fn } = makeSpawn({ throwOnSpawn: new Error("bad binary") });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.passed).toBe(false);
    expect(res.ran).toBe(false);
  });

  it("a synchronous spawn throw WITH a launch errno ⇒ ran:false + env-error summary", async () => {
    const err = Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" });
    const { fn } = makeSpawn({ throwOnSpawn: err });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(false);
    expect(res.summary).toMatch(/could not be launched/i);
  });

  it("verifyInWorktree with NO resolvable command ⇒ ran:false, passed:false (not verified)", async () => {
    const readFileFn = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const res = await verifyInWorktree({ worktreeDir: WT, testCommand: null, readFileFn });
    expect(res.ran).toBe(false);
    expect(res.passed).toBe(false);
    expect(res.summary).toMatch(/not verified/i);
  });

  it("verifyInWorktree resolves config command + runs it (passes the worktree cwd through)", async () => {
    const { fn, calls } = makeSpawn({ code: 0 });
    const res = await verifyInWorktree({ worktreeDir: WT, testCommand: "vitest run", spawnFn: fn });
    expect(res.passed).toBe(true);
    expect(calls[0].binary).toBe("vitest");
    expect(calls[0].args).toEqual(["run"]);
    expect(calls[0].options.cwd).toBe(WT);
  });
});

// ─── TOOL-NOT-FOUND (ran-but-tool-missing) classification ───────────────────
//
// The command SPAWNED fine (unlike ENOENT) and ran, then exited NON-ZERO reporting that
// ITS OWN tool is missing (`uv run pytest` → uv present, pytest absent). Without this it
// looks like a real red and burns the fix budget on an env gap. It must classify like a
// launch failure — ran:false (fix loop skipped) — but flagged `toolMissing:true` and with
// an ENV-flavored, actionable summary. The KEY RISK is the inverse: a GENUINE test failure
// that merely mentions these words in an assertion must STILL be ran:true (enters the loop).
describe("runTests — tool-not-found (ran but its own tool missing) ⇒ ran:false, toolMissing", () => {
  it("uv `Failed to spawn: pytest` (exit 2) ⇒ ran:false + toolMissing + env-flavored summary", async () => {
    // The exact omnius live-bug output: uv launched, pytest was not installed.
    const stderr = "error: Failed to spawn: `pytest`\n  Caused by: No such file or directory (os error 2)\n";
    const { fn } = makeSpawn({ stderr, code: 2 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(false); // ← env gap, NOT a test failure — caller SKIPS the fix loop
    expect(res.toolMissing).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.exitCode).toBe(2); // the child DID run + exit (unlike a spawn ENOENT → null)
    expect(res.summary).toMatch(/Test tooling not available/i);
    expect(res.summary).toMatch(/'pytest'/);
    expect(res.summary).toMatch(/Not adjudicated; fix loop skipped/i);
    expect(res.summary).toMatch(/configure implement\.testCommand/);
  });

  it.each([
    ["shell bash: `bash: pytest: command not found`", "bash: pytest: command not found\n", "pytest"],
    ["shell plain: `pytest: command not found`", "pytest: command not found\n", "pytest"],
    ["zsh: `zsh: command not found: pytest`", "zsh: command not found: pytest\n", "pytest"],
    ["dash: `sh: 1: pytest: not found`", "sh: 1: pytest: not found\n", "pytest"],
    ["python module: `No module named pytest`", "/usr/bin/python: No module named pytest\n", "pytest"],
    ["python ModuleNotFoundError: pytest", "ModuleNotFoundError: No module named 'pytest'\n", "pytest"],
  ])("%s ⇒ ran:false + toolMissing", async (_label, stderr, tool) => {
    const { fn } = makeSpawn({ stderr, code: 1 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(false);
    expect(res.toolMissing).toBe(true);
    expect(res.summary).toMatch(new RegExp(`'${tool}'`));
  });

  it("npm `could not determine executable` (no tool name) ⇒ ran:false + toolMissing (generic)", async () => {
    const { fn } = makeSpawn({ stderr: "npm ERR! could not determine executable to run\n", code: 1 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(false);
    expect(res.toolMissing).toBe(true);
    expect(res.summary).toMatch(/a required test tool/i);
  });

  it("CLI wrapper `error: unrecognized subcommand` ⇒ ran:false + toolMissing", async () => {
    const { fn } = makeSpawn({ stderr: "error: unrecognized subcommand 'run'\n", code: 2 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(false);
    expect(res.toolMissing).toBe(true);
  });

  // ── the CRITICAL no-false-positive guard ──────────────────────────────────
  it("NO FALSE POSITIVE: a GENUINE test failure whose ASSERTION mentions 'pytest' / 'command not found' / 'not found' ⇒ STILL ran:true (enters the fix loop)", async () => {
    // A real vitest red whose diff QUOTES these exact words — but indented + inside quotes,
    // never at column 0 ending its own line. Line-anchored (col-0, `$`) signatures must NOT
    // match this, or a real red would be masked as an env gap (the reviewer's key risk).
    const stdout = [
      "FAIL  src/spawn.test.ts > surfaces a helpful message when a binary is absent",
      "AssertionError: expected error to contain the string",
      `  Expected: "command not found: pytest"`,
      `  Received: "No module named pytest was the wrong message"`,
      "  the CLI should print 'pytest: command not found' but printed 'not found' alone",
      " ❯ src/spawn.test.ts:12:34",
      "",
      "Test Files  1 failed (1)",
      "     Tests  1 failed (1)",
    ].join("\n");
    const { fn } = makeSpawn({ stdout, code: 1 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(true); // ← a REAL red — the fix loop MUST engage
    expect(res.toolMissing).toBeUndefined();
    expect(res.passed).toBe(false);
    expect(res.summary).toMatch(/FAILED/);
  });

  it("NO FALSE POSITIVE: exit 0 with a tool-missing-looking string in output ⇒ passed:true, never toolMissing (detection is gated on non-zero exit)", async () => {
    const { fn } = makeSpawn({ stdout: "pytest: command not found\n", code: 0 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.passed).toBe(true);
    expect(res.toolMissing).toBeUndefined();
  });

  it("NO FALSE POSITIVE: a thrown `Error: command not found` at col 0 ⇒ ran:true (framing word rejected — not a shell tool)", async () => {
    // A test throwing `new Error("command not found")` can print `Error: command not found`
    // at column 0 (unhandled rejection). The token before the colon is a framing word
    // (`Error`), NOT an invoked command — the plausibility guard must reject it so this
    // stays a REAL failure that engages the fix loop.
    const { fn } = makeSpawn({ stderr: "Error: command not found\n    at foo (x.ts:1:1)\n", code: 1 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(true);
    expect(res.toolMissing).toBeUndefined();
  });

  it("NON-runner missing module (`No module named requests`) is left as a REAL failure ⇒ ran:true (tight allowlist — no over-classification)", async () => {
    // A missing APP dependency is NOT in the test-runner allowlist; conservatively treated
    // as a real (adjudicated) failure so we never mask genuine reds behind an env label.
    const { fn } = makeSpawn({ stderr: "ModuleNotFoundError: No module named 'requests'\n", code: 1 });
    const res = await runTests({ worktreeDir: WT, command: CMD, spawnFn: fn });
    expect(res.ran).toBe(true);
    expect(res.toolMissing).toBeUndefined();
  });
});
