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
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AntigravityCliError";
  }
}

/** Build the injection-safe argv array for a non-interactive invocation. */
export function buildCliArgs(input: AntigravityCliInput): string[] {
  const timeoutSeconds = Math.ceil(input.timeoutMs / MS_PER_SECOND);
  return [
    `--print=${input.prompt}`,
    `--model=${input.model}`,
    `--print-timeout=${timeoutSeconds}s`,
  ];
}

/** Translate a raw spawn/exec failure into a clear, actionable error. */
function toCliError(err: NodeJS.ErrnoException, stderr: string): AntigravityCliError {
  if (err.code === "ENOENT") {
    return new AntigravityCliError(
      "Antigravity CLI binary not found on PATH. Install Antigravity and run `agy install`.",
      err,
    );
  }
  const detail = stderr.trim() || err.message;
  if (/not logged in|unauthor|login|sign in/i.test(detail)) {
    return new AntigravityCliError(
      `Antigravity CLI is not logged in. Run \`agy\` once to authenticate. (${detail})`,
      err,
    );
  }
  return new AntigravityCliError(`Antigravity CLI failed: ${detail}`, err);
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
      { timeout: input.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, signal: input.signal, shell: false },
      (err, stdout, stderr) => {
        if (err) {
          reject(toCliError(err as NodeJS.ErrnoException, stderr ?? ""));
          return;
        }
        const text = (stdout ?? "").trim();
        if (text.length === 0) {
          reject(new AntigravityCliError("Antigravity CLI returned empty output."));
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

/**
 * Invoke the Antigravity CLI non-interactively and return its text output.
 * Concurrency is capped; the prompt is never passed through a shell.
 */
export async function invokeAntigravityCli(
  input: AntigravityCliInput,
): Promise<AntigravityCliResult> {
  await acquireSlot();
  try {
    return await runProcess(input);
  } finally {
    releaseSlot();
  }
}
