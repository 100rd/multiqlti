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
 */
import { spawn } from "node:child_process";

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_GRACE_MS = 2_000;

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

export interface CliSpawnRequest {
  /** Binary name or absolute path (e.g. "claude"). */
  binary: string;
  /** Argument array — each element passed verbatim, never shell-expanded. */
  args: string[];
  /** Data written to the child's stdin, then closed. */
  stdin: string;
  /** Per-process timeout in milliseconds. */
  timeoutMs?: number;
  /** Cancels the child when aborted. */
  signal?: AbortSignal;
  /** Extra env vars merged over process.env. */
  env?: Record<string, string>;
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
      `CLI exited with code ${code ?? "null"}${stderr ? `: ${stderr.trim()}` : ""}`,
      code,
      stderr,
    ),
  );
}

/**
 * Spawn a CLI process, feed `stdin`, and resolve with its captured output.
 * Buffers stdout/stderr in memory — intended for bounded CLI responses.
 */
export function spawnCli(request: CliSpawnRequest): Promise<CliSpawnResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<CliSpawnResult>((resolve, reject) => {
    const child = spawn(request.binary, request.args, {
      env: { ...process.env, ...request.env },
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
      child.kill("SIGTERM");
      finish(() => reject(new CliExecutionError("CLI request aborted", null, stderr)));
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
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
 * arrive. Used for `--output-format stream-json` (JSONL). The child is killed
 * on abort/timeout; a non-zero exit after streaming rejects the generator.
 */
export async function* streamCliLines(
  request: CliSpawnRequest,
): AsyncGenerator<string> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const child = spawn(request.binary, request.args, {
    env: { ...process.env, ...request.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const queue: string[] = [];
  let buffer = "";
  let stderr = "";
  let done = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;

  const signalReady = (): void => {
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  const fail = (err: Error): void => {
    failure = err;
    done = true;
    signalReady();
  };

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
    fail(new CliExecutionError(`CLI timed out after ${timeoutMs}ms`, null, stderr));
  }, timeoutMs);

  const onAbort = (): void => {
    child.kill("SIGTERM");
    fail(new CliExecutionError("CLI request aborted", null, stderr));
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });

  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      queue.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
    signalReady();
  });
  child.on("error", (err: NodeJS.ErrnoException) =>
    fail(
      err.code === "ENOENT"
        ? new CliNotInstalledError(request.binary)
        : new CliExecutionError(`Failed to spawn "${request.binary}": ${err.message}`, null, ""),
    ),
  );
  child.on("close", (code) => {
    if (buffer.length > 0) {
      queue.push(buffer);
      buffer = "";
    }
    if (code !== 0 && code !== null) {
      failure = new CliExecutionError(
        `CLI exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
        code,
        stderr,
      );
    }
    done = true;
    signalReady();
  });

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
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    if (!child.killed) child.kill("SIGTERM");
  }
}
