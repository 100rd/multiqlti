/**
 * Antigravity CLI adapter.
 *
 * This module is the SINGLE point of contact with the local Antigravity
 * (Google Antigravity) command-line binary. The provider (antigravity.ts)
 * depends only on `invokeAntigravityCli()` so the exact CLI contract is
 * isolated here and can evolve without touching provider/gateway logic.
 *
 * ── Confirmed CLI contract (discovery, issue #348) ────────────────────────────
 * Binary:   `agy` (installed at ~/.local/bin/agy on the dev machine; resolved
 *           from PATH by default). The Antigravity.app ships a VS Code-style
 *           IDE launcher at Contents/Resources/app/bin/antigravity which is NOT
 *           a headless agent — the headless agent CLI is `agy`.
 * Auth:     Subscription-backed (Antigravity login). NO Gemini API key and NO
 *           Gemini API-token spend. The binary reads its own session/config from
 *           ~/.gemini/antigravity-cli.
 * Invoke:   `agy --print=<prompt> --model=<model> --print-timeout=<dur>`
 *           `--print` runs a single prompt non-interactively and prints the
 *           response to stdout, then exits. Verified manually:
 *             agy --print="Reply with exactly: PONG"  ->  "PONG" (exit 0)
 * Models:   `agy models` lists subscription models, e.g.
 *           "Gemini 3.5 Flash (Medium)", "Gemini 3.1 Pro (High)", ...
 * Output:   Plain UTF-8 text on stdout. (No documented structured/JSON print
 *           format at time of writing — see TODO below.)
 *
 * ── Security ──────────────────────────────────────────────────────────────────
 * The prompt is passed as a single argv element via `execFile` with an ARG
 * ARRAY — never interpolated into a shell string — so message content cannot
 * trigger shell command injection. `shell: false` is the execFile default and
 * is asserted explicitly.
 *
 * ── TODO (unresolved contract details) ────────────────────────────────────────
 * - Structured output: `agy --print` currently returns free-form text. If a
 *   JSON print mode (or token-usage reporting) is added upstream, parse it here
 *   and surface real token counts instead of the length-based estimate.
 * - Streaming: `--print` is one-shot. True token streaming would require the
 *   interactive/ACP transport; the provider emulates streaming by yielding the
 *   full completion once (documented in antigravity.ts).
 */
import { execFile } from "node:child_process";

/** Default binary name; resolved from PATH unless overridden via config. */
export const DEFAULT_ANTIGRAVITY_BIN = "agy";

/** Default subscription model used when a stage does not pin one. */
export const DEFAULT_ANTIGRAVITY_MODEL = "Gemini 3.5 Flash (Medium)";

/** Default wall-clock timeout for a single non-interactive invocation. */
export const DEFAULT_ANTIGRAVITY_TIMEOUT_MS = 120_000;

/** Cap on the captured stdout/stderr buffer to avoid unbounded memory use. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Maximum concurrent CLI processes — the subscription CLI is single-tenant. */
const MAX_CONCURRENCY = 4;

/**
 * Signal used to reap a child that overruns its wall-clock `timeout`. execFile
 * defaults to SIGTERM, but `agy` has been observed to IGNORE SIGTERM and keep
 * running (orphaned, still holding the single-tenant slot). SIGKILL cannot be
 * trapped, so a wedged agy is actually reaped rather than left alive past the
 * deadline.
 */
const KILL_SIGNAL = "SIGKILL" as const;

/**
 * Total attempts for one invocation. `agy --print` intermittently exits 0 with
 * EMPTY stdout (a transient agentic-mode drop) or a transient spawn failure;
 * with no retry a single blip kills a whole multi-stage run after discarding
 * the work already done by earlier stages. Other CLI/HTTP providers retry once;
 * this brings Antigravity in line. Permanent errors (binary missing, not logged
 * in) are NOT retried — they carry `retryable = false`.
 *
 * A WALL-CLOCK TIMEOUT is explicitly NOT retried (see `toCliError`): each
 * attempt is given the FULL `timeoutMs`, so retrying a hung agy would burn
 * MAX_ATTEMPTS × timeoutMs (e.g. 3 × 10 min = 30 min) and block any downstream
 * stage that depends on it (the consilium Judge waiting on the primary). A
 * timeout fails after ONE attempt.
 */
const MAX_ATTEMPTS = 3;

/** Linear backoff base between retries (multiplied by the attempt number). */
const RETRY_BACKOFF_MS = 500;

/** Milliseconds-per-second divisor for the CLI's `--print-timeout` flag. */
const MS_PER_SECOND = 1000;

export interface AntigravityCliInput {
  /** The fully-rendered prompt. Passed as a single argv element (injection-safe). */
  readonly prompt: string;
  /** Subscription model label, e.g. "Gemini 3.5 Flash (Medium)". */
  readonly model: string;
  /** Absolute path or PATH-resolvable binary name. */
  readonly binPath: string;
  /** Per-invocation timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Optional caller abort signal; aborting kills the child process. */
  readonly signal?: AbortSignal;
}

export interface AntigravityCliResult {
  /** Trimmed stdout text from the CLI. */
  readonly text: string;
  /** Bytes of prompt sent, for a rough token estimate by the provider. */
  readonly promptBytes: number;
}

/** Raised when the CLI cannot be found, is not logged in, or fails. */
export class AntigravityCliError extends Error {
  /**
   * Whether a fresh attempt could plausibly succeed. True for transient blips
   * (empty stdout, a generic non-timeout spawn failure); false for deterministic
   * config faults (binary missing, not logged in), a caller abort, AND a
   * wall-clock TIMEOUT — a timeout means the model did not answer inside the cap,
   * and a re-attempt only burns another full cap (the bug this guards against).
   */
  readonly retryable: boolean;

  constructor(message: string, cause?: unknown, retryable = false) {
    super(message);
    this.name = "AntigravityCliError";
    this.cause = cause;
    this.retryable = retryable;
  }
}

/** Build the injection-safe argv array for a non-interactive invocation. */
export function buildCliArgs(input: AntigravityCliInput): string[] {
  const timeoutSeconds = Math.ceil(input.timeoutMs / MS_PER_SECOND);
  return [
    "--mode",
    "plan",
    `--print=${input.prompt}`,
    `--model=${input.model}`,
    `--print-timeout=${timeoutSeconds}s`,
  ];
}

/**
 * The error object execFile passes to its callback. It extends ErrnoException
 * (`code`, `errno`, …) with the process-outcome fields the Node typings keep on
 * `ExecFileException`: `killed` (true when execFile reaped the child for
 * overrunning `timeout`) and `signal` (the kill signal it used).
 */
type ChildExecError = NodeJS.ErrnoException & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

/**
 * Detect a child reaped by execFile's own wall-clock `timeout` (SIGTERM/SIGKILL
 * kill) versus a normal non-zero exit. On timeout Node sets `err.killed = true`
 * and `err.signal` to the kill signal; some runtimes/wrappers also surface
 * `err.code === "ETIMEDOUT"`. A normal failed exit has `killed === false`,
 * `signal === null`, and a numeric/ string `code` — so it is NOT matched here
 * and stays retryable.
 */
function isTimeoutKill(err: ChildExecError): boolean {
  return (
    err.killed === true ||
    err.code === "ETIMEDOUT" ||
    err.signal === "SIGTERM" ||
    err.signal === "SIGKILL"
  );
}

/** Detect a caller-initiated abort (AbortSignal) so it is never mislabeled. */
function isAbort(err: ChildExecError): boolean {
  return err.name === "AbortError" || err.code === "ABORT_ERR";
}

/**
 * Translate a raw spawn/exec failure into a clear, actionable error and set
 * `retryable` correctly. Classification order matters:
 *   1. ENOENT          → binary missing            → NOT retryable
 *   2. caller abort    → request cancelled         → NOT retryable
 *   3. not logged in   → auth fault                → NOT retryable
 *   4. timeout kill    → model didn't answer in cap → NOT retryable (the fix)
 *   5. anything else   → generic transient blip    → retryable
 */
function toCliError(
  err: ChildExecError,
  stderr: string,
  timeoutMs?: number,
): AntigravityCliError {
  if (err.code === "ENOENT") {
    return new AntigravityCliError(
      "Antigravity CLI binary not found on PATH. Install Antigravity and run `agy install`.",
      err,
    );
  }
  if (isAbort(err)) {
    return new AntigravityCliError("Antigravity CLI request aborted.", err, false);
  }
  const detail = stderr.trim() || err.message;
  if (/not logged in|unauthor|login|sign in/i.test(detail)) {
    return new AntigravityCliError(
      `Antigravity CLI is not logged in. Run \`agy\` once to authenticate. (${detail})`,
      err,
    );
  }
  // A wall-clock timeout kill is NOT transient: the model failed to respond
  // within the cap, and each retry would be given the SAME full cap again. Fail
  // after ONE attempt instead of MAX_ATTEMPTS × timeoutMs (the amplification bug).
  if (isTimeoutKill(err)) {
    const seconds =
      timeoutMs != null ? Math.round(timeoutMs / MS_PER_SECOND) : null;
    const window = seconds != null ? `${seconds}s` : "the wall-clock cap";
    return new AntigravityCliError(
      `Antigravity CLI timed out after ${window} — the model did not respond within the wall-clock cap.`,
      err,
      false,
    );
  }
  // Generic non-timeout spawn/exec failure → transient → retryable.
  return new AntigravityCliError(`Antigravity CLI failed: ${detail}`, err, true);
}

let activeProcesses = 0;
const waiters: Array<() => void> = [];

/** Acquire a concurrency slot, queueing if the cap is reached. */
async function acquireSlot(): Promise<void> {
  if (activeProcesses < MAX_CONCURRENCY) {
    activeProcesses++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeProcesses++;
}

/** Release a concurrency slot and wake the next queued waiter, if any. */
function releaseSlot(): void {
  activeProcesses--;
  const next = waiters.shift();
  if (next) next();
}

/** Run the CLI child process and resolve with trimmed stdout. */
function runProcess(input: AntigravityCliInput): Promise<AntigravityCliResult> {
  const args = buildCliArgs(input);
  return new Promise<AntigravityCliResult>((resolve, reject) => {
    const child = execFile(
      input.binPath,
      args,
      {
        timeout: input.timeoutMs,
        killSignal: KILL_SIGNAL,
        maxBuffer: MAX_OUTPUT_BYTES,
        signal: input.signal,
        shell: false,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(toCliError(err as ChildExecError, stderr ?? "", input.timeoutMs));
          return;
        }
        const text = (stdout ?? "").trim();
        if (text.length === 0) {
          // Transient agentic-mode drop / hiccup — exit 0 but nothing on stdout.
          reject(new AntigravityCliError("Antigravity CLI returned empty output.", undefined, true));
          return;
        }
        resolve({ text, promptBytes: Buffer.byteLength(input.prompt, "utf8") });
      },
    );
    // `agy --print` blocks waiting for stdin EOF; execFile leaves the stdin
    // pipe open, so close it immediately or the process hangs until timeout.
    child.stdin?.end();
  });
}

/** Sleep that settles early (rejecting) if the caller's signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AntigravityCliError("Antigravity CLI request aborted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AntigravityCliError("Antigravity CLI request aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Invoke the Antigravity CLI non-interactively and return its text output.
 * Concurrency is capped; the prompt is never passed through a shell. TRANSIENT
 * failures (empty stdout, a generic non-timeout spawn failure) are retried up to
 * MAX_ATTEMPTS with linear backoff. PERMANENT ones fail fast after one attempt:
 * binary missing, not logged in, a caller abort, and — critically — a wall-clock
 * TIMEOUT (so a hung agy fails after 1 × timeoutMs, never MAX_ATTEMPTS ×).
 */
export async function invokeAntigravityCli(
  input: AntigravityCliInput,
): Promise<AntigravityCliResult> {
  await acquireSlot();
  try {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await runProcess(input);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof AntigravityCliError && err.retryable;
        if (!retryable || attempt === MAX_ATTEMPTS || input.signal?.aborted) throw err;
        console.warn(
          `[antigravity] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${(err as Error).message} — retrying`,
        );
        await delay(RETRY_BACKOFF_MS * attempt, input.signal);
      }
    }
    // Unreachable (the loop either returns or throws), but satisfies the type.
    throw lastErr;
  } finally {
    releaseSlot();
  }
}

/**
 * List the subscription model labels exposed by `agy models`.
 *
 * Output is one model label per line, e.g.
 *   Gemini 3.5 Flash (Medium)
 *   Claude Sonnet 4.6 (Thinking)
 * Returned verbatim (trimmed, blanks dropped); each label is what the provider
 * later passes back via `--model=<label>`.
 */
export async function listAntigravityModels(
  binPath: string,
  timeoutMs: number = DEFAULT_ANTIGRAVITY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string[]> {
  await acquireSlot();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const child = execFile(
        binPath,
        ["models"],
        {
          timeout: timeoutMs,
          killSignal: KILL_SIGNAL,
          maxBuffer: MAX_OUTPUT_BYTES,
          signal,
          shell: false,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(toCliError(err as ChildExecError, stderr ?? "", timeoutMs));
            return;
          }
          const labels = (stdout ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          resolve(labels);
        },
      );
      child.stdin?.end();
    });
  } finally {
    releaseSlot();
  }
}
