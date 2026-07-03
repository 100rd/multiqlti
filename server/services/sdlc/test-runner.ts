/**
 * test-runner.ts — SDLC executor, component 6 (Stage 2b): the SANDBOXED
 * subprocess test runner. The security focal point of Stage 2b.
 *
 * Runs the REPO's configured test command INSIDE the isolated SDLC worktree so the
 * develop phase can VERIFY a skilled coder's work against the round's acceptance
 * criteria (per-criterion TDD) before opening the Draft PR. Unlike the coder (which
 * only EDITS files and has NO Bash), this actually EXECUTES repo code — so the
 * confinement here is the whole game, and this module ships INERT: nothing here runs
 * until an operator flips `consiliumLoop.implement.verification.enabled` (default
 * FALSE) on AFTER the security review.
 *
 * SECURITY (BINDING — the veto reviewer's surface):
 *
 *  1. COMMAND SOURCE = config/repo, NEVER untrusted text. The command is resolved
 *     from `consiliumLoop.implement.testCommand` (operator-authored config) ELSE
 *     auto-detected from the worktree's own `package.json` `scripts.test`. It is
 *     NEVER taken from action-point / acceptance-criterion / engineer text. The
 *     untrusted verdict text never reaches argv, a shell, or the command at all.
 *
 *  2. NO SHELL. The command runs via `spawn(binary, args, { shell: false })` with an
 *     ARGUMENT ARRAY. The config command is whitespace-tokenized into argv (no shell
 *     metacharacters are ever interpreted). The package.json path runs the package
 *     manager (`npm test`) as fixed argv — `npm` runs the repo's own `scripts.test`
 *     INTERNALLY; we never read that script string into a shell ourselves.
 *
 *  3. ISOLATED WORKTREE ONLY. `cwd` is the server-minted mkdtemp worktree
 *     (`createSdlcWorktree`). The runner never executes against the user's checkout.
 *
 *  4. HARD TIMEOUT → SIGKILL the whole PROCESS GROUP. The child is spawned
 *     `detached` (its own process group leader); on timeout we SIGKILL the NEGATIVE
 *     pid (`process.kill(-pid, "SIGKILL")`) so npm/vitest fork-worker GRANDCHILDREN
 *     are reaped too — killing only the direct `npm` pid would orphan the workers and
 *     defeat the wall-clock bound (MED-1; the #422 lesson). The timeout is bounded /
 *     clamped (default 5 min).
 *
 *  5. ENV ALLOWLIST (fail-closed). The child gets ONLY a small allowlist
 *     ({@link TEST_ENV_ALLOWLIST}) — PATH/HOME/locale/etc. needed to run. It is a
 *     STRICTER subset of the coder's allowlist: even the claude CLI auth vars are
 *     dropped (the test process needs no model auth). NO DB creds, NO API keys, NO
 *     GH_TOKEN, NO AWS_*, NO PASSWORD/SECRET/TOKEN — a new secret env var is excluded
 *     by default.
 *
 *  6. OUTPUT CAP + SCRUB. Captured stdout/stderr is bounded by a `maxBuffer` cap and
 *     fs paths are scrubbed out of the surfaced summary (no layout disclosure).
 *
 *  7. NEVER THROWS. Any failure (spawn error, bad command, timeout) degrades to
 *     `{ passed: false, ... }` so the caller (the executor) can flag the criterion
 *     and still open the Draft PR at the unchanged human gate.
 *
 * RESIDUAL RISK (documented for the reviewer — see the REPORT's SECURITY FLAG):
 *   `cwd` + env-allowlist + no-shell + timeout confine CREDENTIALS and the COMMAND,
 *   but the test PROCESS itself still has the ambient user's filesystem read/write
 *   and OUTBOUND NETWORK access (there is no namespace/container boundary here). A
 *   malicious test command could read files outside the worktree or exfiltrate over
 *   the network. That is ACCEPTABLE only because the command is operator/repo-trusted
 *   (config or the repo's own package.json — the same trust as the code under
 *   review). For UNTRUSTED repos a container/namespace sandbox (the platform's
 *   `features.sandbox`) is REQUIRED before this kill-switch may be enabled. Default-
 *   off means Stage 2b ships safe regardless of that decision.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CODER_ENV_ALLOWLIST } from "./coder.js";

/** Hard clamps on the test-run timeout (mirrors the config schema bounds). */
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 1_800_000;
const DEFAULT_TIMEOUT_MS = 300_000;
/** Cap on captured stdout+stderr held in memory (defends against an output flood). */
const DEFAULT_MAX_BUFFER = 1_048_576; // 1 MiB
/** Cap on the structured `summary` we surface (keeps the round audit bounded). */
const SUMMARY_MAX = 4_000;

/**
 * The env allowlist for the TEST process — a STRICTER subset of the coder's
 * {@link CODER_ENV_ALLOWLIST}: we keep only the OS/runtime keys and deliberately
 * DROP the claude CLI auth/config vars (CLAUDE_CONFIG_DIR / CLAUDE_CODE_OAUTH_TOKEN)
 * — a test process needs no model auth. Pure allowlist: anything not listed (DB
 * creds, GH/AWS tokens, ANTHROPIC_API_KEY, any *_SECRET/*_TOKEN/PASSWORD) is dropped
 * fail-closed. Derived from the coder allowlist so the two never silently diverge.
 */
export const TEST_ENV_ALLOWLIST: readonly string[] = CODER_ENV_ALLOWLIST.filter(
  (k) => !k.startsWith("CLAUDE_"),
);

/** Build the sanitized, allowlisted env handed to the test subprocess. */
export function sanitizedTestEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of TEST_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/** The structured outcome of a verification run. NEVER thrown — always returned. */
export interface TestRunResult {
  /** True IFF the command resolved, ran, and exited 0 (not timed out). */
  passed: boolean;
  /** Bounded, fs-path-scrubbed human summary (status line + captured output tail). */
  summary: string;
  /** The child's exit code, or null (spawn error / timeout / signal kill). */
  exitCode: number | null;
  /** True when the hard timeout fired and the child was SIGKILL'd. */
  timedOut: boolean;
  /** True when a test command was resolved + actually spawned. False ⇒ no command
   *  (config unset and no usable package.json script) — nothing executed. */
  ran: boolean;
  /**
   * Additive: the command SPAWNED and ran, but its combined output reveals that ITS OWN
   * TOOL is missing — e.g. `uv run pytest` where `uv` launches fine but `pytest` is not
   * installed (uv exits non-zero with `Failed to spawn: pytest`). This is an ENVIRONMENT
   * gap no code change can fix, so it is classified like a top-level spawn failure
   * (`ran:false`) — but flagged here so the caller can surface it as NOT-ADJUDICATED
   * (tooling) distinctly from a launch failure / "no command". OPTIONAL/ADDITIVE —
   * absent unless a tool-missing signature matched the runner's OWN error framing.
   */
  toolMissing?: boolean;
}

/** A resolved, argv-shaped command — the ONLY shape the runner will execute. */
export interface ResolvedTestCommand {
  /** Executable name or path (argv[0]). */
  binary: string;
  /** Argument array (argv[1..]) — passed verbatim, never shell-expanded. */
  args: string[];
  /** Where the command came from (audit/observability only). */
  source: "config" | "package-json";
}

/**
 * Parse the OPERATOR-authored `consiliumLoop.implement.testCommand` into argv by
 * whitespace tokenization. There is NO shell, so no metacharacter is interpreted —
 * the operator supplies a plain command like `npm test` or `pnpm run test` or
 * `vitest run`. A blank/whitespace value ⇒ null (fall through to auto-detect).
 *
 * SECURITY: the input is config-trusted (operator-set), never verdict/AP text.
 */
export function parseConfiguredCommand(
  testCommand: string | null | undefined,
): ResolvedTestCommand | null {
  if (typeof testCommand !== "string") return null;
  const tokens = testCommand.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return { binary: tokens[0], args: tokens.slice(1), source: "config" };
}

/** Narrow, allocation-free guard: read `scripts.test` off parsed package.json. */
function readScriptsTest(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return null;
  const test = (scripts as { test?: unknown }).test;
  return typeof test === "string" ? test : null;
}

/**
 * Auto-detect a test command from the worktree's OWN `package.json` `scripts.test`.
 * When present (and not the npm default placeholder), we run `npm test` as FIXED
 * argv — `npm` executes the repo's `scripts.test` internally, so we NEVER read that
 * (potentially complex / shell-y) script string into a shell ourselves. Returns null
 * when there is no package.json, it is unparseable, or `scripts.test` is missing /
 * the npm placeholder.
 *
 * @param readFileFn injectable for tests (defaults to fs/promises readFile).
 */
export async function detectPackageJsonTest(
  worktreeDir: string,
  readFileFn: (p: string, enc: "utf8") => Promise<string> = readFile,
): Promise<ResolvedTestCommand | null> {
  let raw: string;
  try {
    raw = await readFileFn(join(worktreeDir, "package.json"), "utf8");
  } catch {
    return null; // no package.json (or unreadable) — nothing to auto-detect.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed package.json — degrade to "no command".
  }
  const test = readScriptsTest(parsed);
  if (test === null || test.trim().length === 0) return null;
  // The `npm init` default placeholder is NOT a real test — treat it as absent.
  if (/no test specified/i.test(test)) return null;
  // Run through the package manager as fixed argv; npm runs scripts.test itself.
  return { binary: "npm", args: ["test", "--silent"], source: "package-json" };
}

/**
 * Resolve the command to run: CONFIG `testCommand` first (operator override), then
 * the worktree's package.json `scripts.test`. null ⇒ no runnable command (the caller
 * records "not verified" and flags the criterion). NEVER derives a command from
 * untrusted action-point / acceptance-criterion text.
 */
export async function resolveTestCommand(
  worktreeDir: string,
  testCommand: string | null | undefined,
  deps: { readFileFn?: (p: string, enc: "utf8") => Promise<string> } = {},
): Promise<ResolvedTestCommand | null> {
  return (
    parseConfiguredCommand(testCommand) ??
    (await detectPackageJsonTest(worktreeDir, deps.readFileFn))
  );
}

/** Clamp the timeout to the bounded window (defends a misconfigured huge/tiny value). */
function clampTimeout(ms: number | undefined): number {
  const v = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(v)));
}

/** Scrub fs layout from surfaced output, collapse whitespace (no path disclosure). */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/[ \t]+/g, " ").trim();
}

/**
 * The errno strings that mean the child NEVER STARTED — the OS could not exec the
 * binary at all: `ENOENT` (binary not on PATH / not found) or `EACCES` (found but not
 * executable / permission denied). Node surfaces these as the `code` on the spawn
 * `error` event (or a synchronous spawn throw). Kept STRICT (spawn-level only) on
 * purpose — see {@link isLaunchFailure}.
 */
const LAUNCH_FAILURE_CODES: ReadonlySet<string> = new Set(["ENOENT", "EACCES"]);

/**
 * Is this a spawn-LAUNCH failure — the child process NEVER executed? True IFF the
 * error carries an errno `code` of `ENOENT`/`EACCES` (the OS could not exec the
 * binary). This is STRICTLY distinct from a test that RAN and then failed: a non-zero
 * exit arrives on the `close` event with a NUMERIC `exitCode` and never reaches this
 * predicate. A test-harness crash (segfault / uncaught throw) likewise exits non-zero
 * AFTER launching — it is NOT a launch failure. Keeping the rule to these two spawn-
 * time errnos is what prevents misclassifying a real test failure as an env error.
 */
function isLaunchFailure(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && LAUNCH_FAILURE_CODES.has(code);
}

/**
 * Build the summary for a launch failure. Names the underlying spawn error (scrubbed,
 * e.g. `spawn uv ENOENT`) and points the operator at the fix: the ENVIRONMENT or the
 * configured `testCommand`. NO code change can make an unlaunchable command run, so
 * this summary must read as an environment problem, never a test failure.
 */
function launchFailureSummary(err: unknown): string {
  const msg = scrub(err instanceof Error ? err.message : String(err));
  return `test command could not be launched (${msg}) — fix the environment or config testCommand`.slice(
    0,
    SUMMARY_MAX,
  );
}

/**
 * Build the summary for a run the WALL-CLOCK TIMEOUT killed (SIGKILL). Unlike a red
 * test (which RAN and was adjudicated) OR a launch failure (which never started), a
 * timeout is AMBIGUOUS and UNADJUDICATED: the suite may simply exceed the configured
 * `testRunTimeoutMs`, or the change may have introduced a hang. A coder cannot fix a
 * config-level cap and the NEXT run pays the SAME wall-clock, so the caller SKIPS the
 * fix loop and records the criterion NOT-ADJUDICATED. `ran` stays true (the process DID
 * run, unlike ENOENT) — the message names the cap + both hypotheses so an operator (or
 * the next review round) can act, and states the policy (fix loop skipped) explicitly.
 */
function timeoutSummary(timeoutMs: number): string {
  return `TIMED OUT after ${timeoutMs}ms — suite may exceed testRunTimeoutMs (raise the cap for a slow suite) or the change introduced a hang; not adjudicated, fix loop skipped`.slice(
    0,
    SUMMARY_MAX,
  );
}

/**
 * Known TEST-RUNNER python modules. The `No module named X` signature is treated as a
 * tool-not-found ENVIRONMENT error ONLY when X is one of these (i.e. `python -m pytest`
 * ran but pytest is not installed). We do NOT generalize to ANY missing module: an
 * arbitrary `No module named <app_dep>` is left as a REAL failure (conservative — a
 * false-negative, never a false-positive that masks a genuine red). Kept TIGHT.
 */
const TEST_RUNNER_MODULES: ReadonlySet<string> = new Set([
  "pytest",
  "unittest",
  "nose",
  "nose2",
  "tox",
]);

/** Strip decorating quotes/backticks/trailing punctuation off an extracted tool token. */
function cleanTool(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/^[`'"]+|[`'".,:;]+$/g, "").trim();
  return t.length > 0 ? t : null;
}

/**
 * Error/assertion FRAMING words that are NEVER an invoked tool name. Guards the shell
 * `<tool>: command not found` / `<tool>: not found` patterns against a GENUINE failure
 * line like `Error: command not found` (a thrown `Error("command not found")`) being
 * misread as a shell tool-missing — the token before the colon would be `Error`, not a
 * real command. If the captured "tool" is one of these, we do NOT classify (fall through
 * ⇒ real failure ⇒ the fix loop still engages: the preferred false-negative direction).
 */
const NON_TOOL_TOKENS: ReadonlySet<string> = new Set([
  "error",
  "assertionerror",
  "typeerror",
  "rangeerror",
  "referenceerror",
  "syntaxerror",
  "evalerror",
  "urierror",
  "expected",
  "received",
  "actual",
  "warning",
  "note",
  "caused",
  "at",
]);

/** cleanTool + reject error/assertion framing words (see {@link NON_TOOL_TOKENS}). */
function plausibleTool(raw: string | null | undefined): string | null {
  const t = cleanTool(raw);
  if (t === null) return null;
  return NON_TOOL_TOKENS.has(t.toLowerCase()) ? null : t;
}

/**
 * TOOL-NOT-FOUND (ran-but-tool-missing) detection on the child's OWN combined output.
 *
 * The distinction from a top-level launch failure (ENOENT/EACCES on the spawn `error`
 * event) is: HERE the command binary SPAWNED fine and RAN, then reported — via its own
 * error framing on a NON-ZERO exit — that a tool IT needs is missing (`uv run pytest`
 * where uv is present but pytest is not). Node sees a normal non-zero `close`, so without
 * this the executor treats it as a REAL test failure and burns the whole fix budget on an
 * environment gap no code edit can fix (the observed omnius bug: 3 APs × 3 iterations on
 * `Failed to spawn: pytest`).
 *
 * FALSE-POSITIVE DEFENSE (the key risk — masking a real test failure): every signature is
 * a LINE-ANCHORED (`^…` with the `m` flag), COLUMN-0 match of a TOOL's or SHELL's own
 * error line — NOT an arbitrary substring. A genuine test failure that merely mentions
 * "pytest" / "not found" / "command not found" does so INSIDE an assertion diff — indented
 * and/or quoted (`  Expected: "command not found: pytest"`), never at column 0 ending its
 * own line — so it does NOT match. We prefer a FALSE-NEGATIVE (treat as a real failure,
 * enter the fix loop) over a FALSE-POSITIVE (skip the loop, mask a red). Detection runs on
 * the RAW output (pre-scrub) so line structure is intact, and ONLY on a non-zero exit.
 *
 * Returns the matched tool name (best-effort, for the summary) or null when unmatched.
 */
function detectToolMissing(output: string): { tool: string | null } | null {
  if (typeof output !== "string" || output.length === 0) return null;

  // 1. uv / spawn-wrapper (col 0): `error: Failed to spawn: `pytest`` (+ `Caused by: No
  //    such file or directory`). Keyed on the distinctive `Failed to spawn:` framing.
  let m = /^(?:error:\s*)?Failed to spawn:\s*(?<tool>[`'"]?[\w.\-/]+)/im.exec(output);
  if (m) return { tool: cleanTool(m.groups?.tool) };

  // 3a. shell (col 0): `bash: pytest: command not found` / `pytest: command not found`.
  //     Anchored to end-of-line ($) so a mid-line assertion mention cannot match; the tool
  //     token is plausibility-checked so `Error: command not found` is NOT misread.
  m = /^(?:[\w.\-/]+:[ \t]*)?(?<tool>[\w.\-/]+):[ \t]*command not found[ \t]*$/im.exec(output);
  if (m) {
    const tool = plausibleTool(m.groups?.tool);
    if (tool) return { tool };
  }

  // 3b. zsh (col 0): `zsh: command not found: pytest`. End-anchored.
  m = /^(?:[\w.\-/]+:[ \t]*)?command not found:[ \t]*(?<tool>[\w.\-/]+)[ \t]*$/im.exec(output);
  if (m) {
    const tool = plausibleTool(m.groups?.tool);
    if (tool) return { tool };
  }

  // 4b. dash/busybox (col 0): `sh: 1: pytest: not found` / `sh: pytest: not found`. The
  //     `sh:` prefix is required, so this is tightly the shell's own line.
  m = /^sh:[ \t]*(?:\d+:[ \t]*)?(?<tool>[\w.\-/]+):[ \t]*not found[ \t]*$/im.exec(output);
  if (m) {
    const tool = plausibleTool(m.groups?.tool);
    if (tool) return { tool };
  }

  // 4a. npm (col 0): `npm ERR! could not determine executable to run` — no tool name.
  if (/^npm ERR!.*could not determine executable/im.test(output)) return { tool: null };

  // 5. CLI wrapper (col 0, clap/cobra framing): `error: unrecognized subcommand 'foo'`.
  m = /^error:[ \t]*unrecognized subcommand[ \t:'"`]*(?<tool>[\w.\-]+)?/im.exec(output);
  if (m) return { tool: cleanTool(m.groups?.tool ?? null) };

  // 2. python (col 0): `... : No module named pytest` / `ModuleNotFoundError: No module
  //    named 'pytest'` — ONLY when the module is a known TEST RUNNER (see the set), so a
  //    missing APP dependency is left as a real failure (conservative).
  m = /^(?:.*?:[ \t]*)?(?:ModuleNotFoundError:[ \t]*)?No module named[ \t]*['"]?(?<mod>[\w.]+)/im.exec(
    output,
  );
  if (m) {
    const mod = (m.groups?.mod ?? "").split(".")[0];
    if (mod.length > 0 && TEST_RUNNER_MODULES.has(mod)) return { tool: mod };
  }

  return null;
}

/**
 * Build the summary for a ran-but-tool-missing result. Reads unambiguously as a config/
 * environment gap (NOT a code failure), names the missing tool, and states the policy
 * (not adjudicated; fix loop skipped) so the operator knows to configure the test command
 * rather than expect a coder to "fix" it.
 */
function toolMissingSummary(tool: string | null): string {
  const name = tool ? `'${tool}'` : "a required test tool";
  return `Test tooling not available: ${name} not found (command ran but its tool is missing) — configure implement.testCommand / perRepo for this repo. Not adjudicated; fix loop skipped.`.slice(
    0,
    SUMMARY_MAX,
  );
}

/** Build the bounded, scrubbed summary. Keeps the OUTPUT TAIL (failures live there). */
function buildSummary(
  output: string,
  exitCode: number | null,
  timedOut: boolean,
  truncated: boolean,
): string {
  const status = timedOut
    ? "TIMED OUT — test process killed (SIGKILL) after the configured timeout"
    : exitCode === 0
      ? "PASSED"
      : `FAILED (exit ${exitCode ?? "null"})`;
  const scrubbed = scrub(output);
  // Reserve room for the status header; keep the TAIL of the output.
  const budget = Math.max(0, SUMMARY_MAX - status.length - 16);
  const tail = scrubbed.length > budget ? scrubbed.slice(scrubbed.length - budget) : scrubbed;
  const trunc = truncated || scrubbed.length > budget ? " [output truncated]" : "";
  return `${status}${trunc}\n${tail}`.trim().slice(0, SUMMARY_MAX);
}

/**
 * The minimal child-process surface the runner drives. Lets unit tests inject a fake
 * child (an EventEmitter-ish object) WITHOUT constructing a real ChildProcess, and
 * keeps the module `any`-free.
 */
export interface TestChildProcess {
  /** OS pid (used to SIGKILL the whole process group on timeout). */
  pid?: number;
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Spawn seam — defaults to node's `spawn`; tests inject a fake. */
export type TestSpawnFn = (
  binary: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    detached: boolean;
    stdio: ["ignore", "pipe", "pipe"];
  },
) => TestChildProcess;

const defaultSpawn: TestSpawnFn = (binary, args, options) =>
  spawn(binary, [...args], options) as unknown as TestChildProcess;

/**
 * MED-1: SIGKILL the child's whole PROCESS GROUP by its NEGATIVE pid. The child is
 * spawned `detached`, so it leads its own group; `process.kill(-pid, ...)` signals
 * every process in that group (npm + its forked test workers). Default seam — tests
 * inject a fake to assert the group-kill path without signalling a real group.
 */
export type KillGroupFn = (pid: number) => void;

const defaultKillGroup: KillGroupFn = (pid) => {
  process.kill(-pid, "SIGKILL");
};

export interface RunTestsOptions {
  /** Isolated worktree dir — the child's cwd (server-minted; never the user checkout). */
  worktreeDir: string;
  /** The resolved argv command (config or package.json — never untrusted text). */
  command: ResolvedTestCommand;
  /** Hard wall-clock timeout (ms) — clamped to [10s, 30m]. SIGKILL on expiry. */
  timeoutMs?: number;
  /** Cap on captured stdout+stderr bytes (default 1 MiB). */
  maxBuffer?: number;
  /** Override the spawned env (tests). Defaults to {@link sanitizedTestEnv} (allowlist). */
  env?: NodeJS.ProcessEnv;
  /** Spawn seam (tests). Defaults to node's `spawn` with `shell: false`. */
  spawnFn?: TestSpawnFn;
  /** Process-group SIGKILL seam (tests). Defaults to `process.kill(-pid, "SIGKILL")`. */
  killGroupFn?: KillGroupFn;
}

/**
 * Execute a RESOLVED command in the worktree and return a structured result. NEVER
 * throws. Enforces: no-shell argv spawn, env allowlist, hard timeout→SIGKILL,
 * output cap, fs-path scrub.
 */
export function runTests(opts: RunTestsOptions): Promise<TestRunResult> {
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const env = opts.env ?? sanitizedTestEnv();
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const killGroup = opts.killGroupFn ?? defaultKillGroup;

  return new Promise<TestRunResult>((resolve) => {
    let settled = false;
    let output = "";
    let truncated = false;
    let timedOut = false;

    const append = (chunk: Buffer | string): void => {
      if (output.length >= maxBuffer) {
        truncated = true;
        return; // already at the cap; stop accumulating (bounded memory).
      }
      output += typeof chunk === "string" ? chunk : chunk.toString();
      if (output.length > maxBuffer) {
        output = output.slice(0, maxBuffer);
        truncated = true;
      }
    };

    let child: TestChildProcess;
    try {
      child = spawnFn(opts.command.binary, opts.command.args, {
        cwd: opts.worktreeDir, // isolated worktree ONLY.
        env, // fail-closed allowlist — NO secrets reach the test process.
        shell: false, // ARG ARRAY, no shell — no metacharacter interpretation.
        detached: true, // MED-1: own process group ⇒ group-kill reaps forked workers.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // Spawn threw synchronously (e.g. bad binary) — degrade, never throw. The child
      // never started ⇒ ran:false. A launch errno (ENOENT/EACCES) gets the explicit
      // "could not be launched" summary so the caller reads it as an ENV error.
      resolve({
        passed: false,
        summary: isLaunchFailure(err)
          ? launchFailureSummary(err)
          : scrub(err instanceof Error ? err.message : String(err)).slice(0, SUMMARY_MAX),
        exitCode: null,
        timedOut: false,
        ran: false,
      });
      return;
    }

    const finish = (result: TestRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // Hard timeout → SIGKILL the whole PROCESS GROUP (MED-1). Killing only the direct
    // child pid would orphan npm/vitest fork-worker grandchildren and defeat the
    // wall-clock bound; the negative-pid signal reaps the entire detached group. The
    // child's own exit still settles the promise via the `close` handler.
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (typeof pid === "number") {
        try {
          killGroup(pid); // process.kill(-pid, "SIGKILL") — the whole group.
        } catch {
          // the group may already be gone — harmless.
        }
      }
      // Belt-and-suspenders: also signal the direct child (no-op if pid was unknown
      // or the group kill already reaped it).
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — the close handler still settles the promise.
      }
    }, timeoutMs);

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    // The spawn `error` event. A LAUNCH failure (ENOENT/EACCES — the binary never
    // exec'd, e.g. `spawn uv ENOENT`) is an ENVIRONMENT problem: the child NEVER ran,
    // so ran:false (no code change can fix it — the caller must SKIP the fix loop). Any
    // OTHER error event fires only AFTER the child started (e.g. an I/O error mid-run),
    // so it ran (ran:true) and is treated as before. A non-zero test exit does NOT come
    // through here at all — it settles via the `close` handler with a numeric exitCode.
    child.on("error", (err: Error) => {
      const launch = isLaunchFailure(err);
      finish({
        passed: false,
        summary: launch ? launchFailureSummary(err) : scrub(err.message).slice(0, SUMMARY_MAX),
        exitCode: null,
        timedOut,
        ran: !launch,
      });
    });
    // A wall-clock TIMEOUT (SIGKILL) settles here via the child's close event. It is
    // AMBIGUOUS and UNADJUDICATED — the process DID run (ran:true, unlike ENOENT) but
    // was killed before a verdict, so it gets the explicit "not adjudicated, fix loop
    // skipped" summary naming the configured cap. The caller SKIPS the fix loop on the
    // `timedOut` flag (see the executor's `!result.timedOut` gate). A NORMAL exit keeps
    // the pass/fail summary with the captured output tail.
    //
    // TOOL-NOT-FOUND (ran-but-tool-missing): on a NON-ZERO, non-timeout exit we inspect the
    // child's OWN output for a tool-missing signature (`uv run pytest` → uv ran but pytest
    // is absent). A match is an ENVIRONMENT gap no code edit can fix, so — exactly like the
    // top-level ENOENT (#444) — we classify it `ran:false` (the caller's `result.ran` gate
    // SKIPS the fix loop, saving the whole budget) and flag `toolMissing` so it surfaces as
    // NOT-ADJUDICATED (tooling), distinct from a real red. Only checked on a non-zero exit,
    // and only against the runner's own line-anchored error framing (no false positives).
    child.on("close", (code: number | null) => {
      if (!timedOut && code !== 0) {
        const missing = detectToolMissing(output);
        if (missing) {
          finish({
            passed: false,
            summary: toolMissingSummary(missing.tool),
            exitCode: code,
            timedOut: false,
            ran: false, // env gap — no code fix; caller SKIPS the fix loop (like ENOENT).
            toolMissing: true,
          });
          return;
        }
      }
      finish({
        passed: !timedOut && code === 0,
        summary: timedOut ? timeoutSummary(timeoutMs) : buildSummary(output, code, timedOut, truncated),
        exitCode: code,
        timedOut,
        ran: true,
      });
    });
  });
}

/**
 * Top-level verification entry point: resolve the command (config → package.json),
 * then run it in the worktree. NEVER throws. When NO command resolves, returns a
 * `{ passed: false, ran: false }` "not verified" result so the caller flags the
 * criterion rather than asserting a false green.
 */
export async function verifyInWorktree(opts: {
  worktreeDir: string;
  testCommand: string | null | undefined;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  spawnFn?: TestSpawnFn;
  readFileFn?: (p: string, enc: "utf8") => Promise<string>;
}): Promise<TestRunResult> {
  let command: ResolvedTestCommand | null;
  try {
    command = await resolveTestCommand(opts.worktreeDir, opts.testCommand, {
      readFileFn: opts.readFileFn,
    });
  } catch (err) {
    return {
      passed: false,
      summary: scrub(err instanceof Error ? err.message : String(err)).slice(0, SUMMARY_MAX),
      exitCode: null,
      timedOut: false,
      ran: false,
    };
  }
  if (!command) {
    return {
      passed: false,
      summary:
        "not verified — no test command (config testCommand unset and no usable package.json scripts.test)",
      exitCode: null,
      timedOut: false,
      ran: false,
    };
  }
  return runTests({
    worktreeDir: opts.worktreeDir,
    command,
    timeoutMs: opts.timeoutMs,
    maxBuffer: opts.maxBuffer,
    env: opts.env,
    spawnFn: opts.spawnFn,
  });
}
