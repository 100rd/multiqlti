/**
 * Small, self-contained helper for CLI-backed LLM providers that shell out to a
 * locally installed binary (e.g. the `claude` CLI for subscription-based access).
 *
 * Responsibilities kept intentionally narrow so sibling CLI providers (issue
 * #348, Antigravity CLI) can reuse it after merge:
 *   - Spawn a binary with an ARGUMENT ARRAY (never a shell string) → no command
 *     injection. The prompt is written to the child's stdin, never passed as an
 *     argv element.
 *   - Enforce a per-process timeout and honour an optional AbortSignal.
 *   - Cap the number of concurrently running child processes.
 *   - Surface a clear, typed error when the binary is missing (ENOENT).
 *
 * `streamCliLines` additionally enforces, for the long-running stage path
 * (streaming-stage-execution): an idle (inactivity) timeout, an independent
 * overall wall-clock cap, a cumulative output byte cap, and a max single-line
 * length guard. Every failure path settles exactly once and kills the child
 * with SIGTERM→SIGKILL escalation (Security C2/C3/H1/H3/H4).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { scrubSecrets } from "../secret-scrub";

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_GRACE_MS = 2_000;
/** Default cap on a single newline-less line (no-newline flood guard, H4). */
const DEFAULT_MAX_LINE_BYTES = 1_048_576; // 1 MiB
/** Default cumulative output cap (matches Antigravity MAX_OUTPUT_BYTES). */
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB

/** Thrown when the underlying CLI binary is not installed / not on PATH. */
export class CliNotInstalledError extends Error {
  constructor(binary: string) {
    super(`CLI binary "${binary}" is not installed or not on PATH`);
    this.name = "CliNotInstalledError";
  }
}

/** Thrown when the CLI exits non-zero, times out, or is aborted. */
export class CliExecutionError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CliExecutionError";
  }
}

/** Distinct failure class: no output for the idle window (hung CLI). */
export class CliIdleTimeoutError extends CliExecutionError {
  constructor(idleTimeoutMs: number, stderr: string) {
    super(`CLI idle for ${idleTimeoutMs}ms (no output)`, null, stderr);
    this.name = "CliIdleTimeoutError";
  }
}

/** Distinct failure class: overall wall-clock cap exceeded. */
export class CliOverallTimeoutError extends CliExecutionError {
  constructor(overallTimeoutMs: number, stderr: string) {
    super(`CLI exceeded overall cap of ${overallTimeoutMs}ms`, null, stderr);
    this.name = "CliOverallTimeoutError";
  }
}

/** Distinct failure class: cumulative output byte cap exceeded. */
export class CliByteCapError extends CliExecutionError {
  constructor(maxOutputBytes: number, stderr: string) {
    super(`CLI output exceeded ${maxOutputBytes} bytes`, null, stderr);
    this.name = "CliByteCapError";
  }
}

/** Distinct failure class: a single line exceeded the max line length. */
export class CliLineCapError extends CliExecutionError {
  constructor(maxLineBytes: number, stderr: string) {
    super(`CLI emitted a line exceeding ${maxLineBytes} bytes (no newline)`, null, stderr);
    this.name = "CliLineCapError";
  }
}

/** Distinct failure class: caller aborted the request mid-flight. */
export class CliAbortError extends CliExecutionError {
  constructor(stderr: string) {
    super("CLI request aborted", null, stderr);
    this.name = "CliAbortError";
  }
}

export interface CliSpawnRequest {
  /** Binary name or absolute path (e.g. "claude"). */
  binary: string;
  /** Argument array — each element passed verbatim, never shell-expanded. */
  args: string[];
  /** Data written to the child's stdin, then closed. */
  stdin: string;
  /**
   * Overall wall-clock cap in ms. For `spawnCli` this is the only timeout
   * (default 120s, short callers). For `streamCliLines` it is the overall cap
   * that is NEVER reset by chunks.
   */
  timeoutMs?: number;
  /**
   * Idle (inactivity) timeout in ms (streamCliLines only). Reset on each stdout
   * chunk. Fires only when no output has arrived for this window.
   */
  idleTimeoutMs?: number;
  /** Cumulative stdout byte cap (streamCliLines only). */
  maxOutputBytes?: number;
  /** Max single newline-less line length (streamCliLines only, H4). */
  maxLineBytes?: number;
  /** Cancels the child when aborted. */
  signal?: AbortSignal;
  /** Extra env vars merged over process.env. */
  env?: Record<string, string>;
  /**
   * Working directory for the child. Used by agentic CLI callers (e.g. the SDLC
   * coder) to confine the process to an isolated worktree; omitted = inherit the
   * server cwd (the prior behaviour for short LLM callers).
   */
  cwd?: string;
  /**
   * COMPLETE replacement env for the child (H-1). When set, the child gets EXACTLY
   * this map — `process.env` is NOT merged in — so a caller can spawn an agentic
   * coder under a sanitized, allowlisted env that omits inherited secrets
   * (DB creds, GH/AWS tokens, …). When undefined, the prior merge behaviour
   * (`{...process.env, ...env}`) applies for the short LLM callers.
   */
  envOverride?: NodeJS.ProcessEnv;
}

export interface CliSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Bounded gate that limits how many child processes run at once. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number = DEFAULT_MAX_CONCURRENCY) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /**
   * Acquire a slot for a manually-managed lifetime (e.g. an async generator that
   * holds the slot until it completes/errors/early-returns). Returns an
   * idempotent release callback the caller MUST invoke in a finally block.
   */
  async acquireSlot(): Promise<() => void> {
    await this.acquire();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

/**
 * SIGTERM the child, then SIGKILL after the grace window (C3). The SIGKILL is
 * unconditional: a sent SIGTERM flips child.killed even while the process is
 * still alive, so guarding the SIGKILL on !child.killed would defeat the
 * escalation. SIGKILL on an already-dead pid is a harmless no-op.
 */
function killWithEscalation(child: ChildProcess): void {
  child.kill("SIGTERM");
  setTimeout(() => {
    child.kill("SIGKILL");
  }, SIGKILL_GRACE_MS);
}

function rejectOnSpawnError(
  binary: string,
  reject: (e: Error) => void,
): (err: NodeJS.ErrnoException) => void {
  return (err) => {
    if (err.code === "ENOENT") {
      reject(new CliNotInstalledError(binary));
      return;
    }
    reject(new CliExecutionError(`Failed to spawn "${binary}": ${err.message}`, null, ""));
  };
}

function settleClose(
  code: number | null,
  stdout: string,
  stderr: string,
  resolve: (r: CliSpawnResult) => void,
  reject: (e: Error) => void,
): void {
  if (code === 0) {
    resolve({ stdout, stderr, exitCode: 0 });
    return;
  }
  reject(
    new CliExecutionError(
      `CLI exited with code ${code ?? "null"}${stderr ? `: ${scrubSecrets(stderr.trim())}` : ""}`,
      code,
      stderr,
    ),
  );
}

/**
 * Spawn a CLI process, feed `stdin`, and resolve with its captured output.
 * Buffers stdout/stderr in memory — intended for bounded CLI responses
 * (short callers: health-check ping, model discovery). Keeps the 120s default
 * and NO idle/byte caps — those belong to the streaming stage path only (H2).
 */
export function spawnCli(request: CliSpawnRequest): Promise<CliSpawnResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<CliSpawnResult>((resolve, reject) => {
    const child = spawn(request.binary, request.args, {
      cwd: request.cwd,
      env: request.envOverride ?? { ...process.env, ...request.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = (): void => {
      killWithEscalation(child);
      finish(() => reject(new CliAbortError(stderr)));
    };

    const timer = setTimeout(() => {
      killWithEscalation(child);
      finish(() =>
        reject(new CliExecutionError(`CLI timed out after ${timeoutMs}ms`, null, stderr)),
      );
    }, timeoutMs);

    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish(() => rejectOnSpawnError(request.binary, reject)(err)),
    );
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) =>
      finish(() => settleClose(code, stdout, stderr, resolve, reject)),
    );

    child.stdin.end(request.stdin);
  });
}

/**
 * Spawn a CLI process and yield its stdout split into complete lines as they
 * arrive. Used for `--output-format stream-json` (JSONL).
 *
 * Timeout model (streaming-stage-execution): an idle timer reset on each chunk,
 * an independent overall cap armed once at spawn, a cumulative byte cap, and a
 * max single-line guard. Every failure path settles exactly once via `settle()`
 * (clears both timers, removes the abort listener, kills the child with
 * SIGTERM→SIGKILL escalation), so there are no leaked timers/listeners and the
 * child is never orphaned (C2/C3).
 */
export async function* streamCliLines(
  request: CliSpawnRequest,
): AsyncGenerator<string> {
  const overallTimeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = request.idleTimeoutMs;
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxLineBytes = request.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

  const child = spawn(request.binary, request.args, {
    cwd: request.cwd,
    env: request.envOverride ?? { ...process.env, ...request.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const queue: string[] = [];
  let buffer = "";
  let stderr = "";
  let totalBytes = 0;
  let done = false;
  let failure: Error | null = null;
  let settled = false;
  let wake: (() => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const signalReady = (): void => {
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  // Single idempotent settle: clears both timers, removes the abort listener,
  // and (for termination paths) kills the child with SIGTERM→SIGKILL — exactly
  // once on EVERY exit path. `kill` is false only for a clean self-exit where
  // the child is already gone (avoids scheduling a stray post-exit SIGKILL).
  const settle = (err: Error | null, kill = true): void => {
    if (settled) return;
    settled = true;
    clearTimeout(overallTimer);
    if (idleTimer) clearTimeout(idleTimer);
    request.signal?.removeEventListener("abort", onAbort);
    if (kill) killWithEscalation(child);
    if (err) failure = err;
    done = true;
    signalReady();
  };

  // Normal completion path (child closed on its own): flush the remaining
  // buffer, then settle exactly once WITHOUT killing — the child already exited.
  const settleNormal = (code: number | null): void => {
    if (settled) return;
    if (buffer.length > 0) {
      queue.push(buffer);
      buffer = "";
    }
    const err =
      code !== 0 && code !== null
        ? new CliExecutionError(
            `CLI exited with code ${code}${stderr ? `: ${scrubSecrets(stderr.trim())}` : ""}`,
            code,
            stderr,
          )
        : null;
    settle(err, false);
  };

  const armIdle = (): void => {
    if (idleTimeoutMs === undefined) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      settle(new CliIdleTimeoutError(idleTimeoutMs, stderr));
    }, idleTimeoutMs);
  };

  const overallTimer = setTimeout(() => {
    settle(new CliOverallTimeoutError(overallTimeoutMs, stderr));
  }, overallTimeoutMs);

  const onAbort = (): void => {
    settle(new CliAbortError(stderr));
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });

  armIdle();

  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout.on("data", (chunk: Buffer) => {
    if (settled) return;
    armIdle(); // reset idle timer on every chunk (overall cap untouched)

    totalBytes += chunk.length;
    if (totalBytes > maxOutputBytes) {
      settle(new CliByteCapError(maxOutputBytes, stderr));
      return;
    }

    buffer += chunk.toString();
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      queue.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
    // Guard a newline-less flood: the unflushed tail must stay bounded (H4).
    if (buffer.length > maxLineBytes) {
      settle(new CliLineCapError(maxLineBytes, stderr));
      return;
    }
    signalReady();
  });
  child.on("error", (err: NodeJS.ErrnoException) =>
    settle(
      err.code === "ENOENT"
        ? new CliNotInstalledError(request.binary)
        : new CliExecutionError(`Failed to spawn "${request.binary}": ${err.message}`, null, ""),
    ),
  );
  child.on("close", (code) => settleNormal(code));

  child.stdin.end(request.stdin);

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift() as string;
      }
      if (done) break;
      await new Promise<void>((resolve) => (wake = resolve));
    }
    if (failure) throw failure;
  } finally {
    // Defensive: if the consumer breaks early, settle (idempotent) so timers /
    // the abort listener are cleared and the child is killed.
    settle(null);
  }
}
