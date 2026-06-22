/**
 * Unit tests for the Antigravity CLI adapter (issue #348).
 *
 * `node:child_process.execFile` is mocked — no real `agy` process is spawned.
 * Tests verify:
 *   - invokeAntigravityCli() resolves with trimmed stdout + prompt byte count
 *   - execFile is called with shell:false and the injection-safe ARG ARRAY
 *   - ENOENT → "binary not found" error
 *   - not-logged-in stderr → clear auth error
 *   - empty stdout → "empty output" error
 *   - concurrency cap serialises calls beyond the limit
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type ExecFileCb = (
  err: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
) => void;

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  invokeAntigravityCli,
  AntigravityCliError,
} from "../../../server/gateway/providers/antigravity-cli.js";

const BASE_INPUT = {
  prompt: "hello; rm -rf /",
  model: "Gemini 3.5 Flash (Medium)",
  binPath: "agy",
  timeoutMs: 30_000,
} as const;

/** Spy for the most recent child's stdin.end() — execFile returns a ChildProcess. */
let lastStdinEnd: ReturnType<typeof vi.fn>;

/** Fake ChildProcess: real execFile returns one; the provider closes its stdin. */
function makeFakeChild(): { stdin: { end: ReturnType<typeof vi.fn> } } {
  lastStdinEnd = vi.fn();
  return { stdin: { end: lastStdinEnd } };
}

/** Make execFile invoke its callback synchronously with the given values. */
function respondWith(err: NodeJS.ErrnoException | null, stdout: string, stderr = ""): void {
  execFileMock.mockImplementationOnce(
    (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
      cb(err, stdout, stderr);
      return makeFakeChild();
    },
  );
}

/**
 * Retryable errors are re-attempted up to MAX_ATTEMPTS (3) in antigravity-cli.ts,
 * so the mock must supply a response for EVERY attempt — otherwise attempt 2 hits
 * an unmocked execFile that returns `undefined`, and `undefined.stdin.end()`
 * throws a TypeError that MASKS the error under test. Register the same response
 * for all 3 attempts. (Non-retryable cases — ENOENT, not-logged-in — fail fast
 * after one attempt and keep the single-response respondWith.)
 */
function respondWithRetryable(
  err: NodeJS.ErrnoException | null,
  stdout: string,
  stderr = "",
): void {
  // Exactly MAX_ATTEMPTS `…Once` responses (not a persistent mockImplementation,
  // which `vi.clearAllMocks()` in beforeEach does NOT clear and would leak into
  // the next test). Self-limiting + isolated, matching respondWith's pattern.
  for (let i = 0; i < 3; i++) respondWith(err, stdout, stderr);
}

describe("invokeAntigravityCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves with trimmed stdout and prompt byte count", async () => {
    respondWith(null, "  the answer  \n");

    const result = await invokeAntigravityCli({ ...BASE_INPUT });

    expect(result.text).toBe("the answer");
    expect(result.promptBytes).toBe(Buffer.byteLength(BASE_INPUT.prompt, "utf8"));
  });

  it("invokes execFile with shell:false and an injection-safe arg array", async () => {
    respondWith(null, "ok");

    await invokeAntigravityCli({ ...BASE_INPUT });

    const [bin, args, opts] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { shell?: boolean; timeout?: number },
    ];
    expect(bin).toBe("agy");
    expect(args).toContain("--print=hello; rm -rf /");
    expect(args).toContain("--model=Gemini 3.5 Flash (Medium)");
    expect(opts.shell).toBe(false);
    expect(opts.timeout).toBe(30_000);
  });

  it("maps ENOENT to a clear 'binary not found' error", async () => {
    const enoent = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    respondWith(enoent, "", "");

    await expect(invokeAntigravityCli({ ...BASE_INPUT })).rejects.toThrow(
      /not found on PATH/i,
    );
  });

  it("maps a not-logged-in stderr to a clear auth error", async () => {
    const err = Object.assign(new Error("exit 1"), { code: 1 });
    respondWith(err, "", "Error: not logged in. Please sign in.");

    await expect(invokeAntigravityCli({ ...BASE_INPUT })).rejects.toThrow(
      /not logged in/i,
    );
  });

  it("maps a generic non-zero exit to a CLI failure error", async () => {
    const err = Object.assign(new Error("boom"), { code: 1 });
    // Retryable: supply a response for all 3 attempts (MAX_ATTEMPTS).
    respondWithRetryable(err, "", "model unavailable");

    await expect(invokeAntigravityCli({ ...BASE_INPUT })).rejects.toThrow(
      /CLI failed: model unavailable/i,
    );
  });

  it("rejects empty stdout as malformed output", async () => {
    // Retryable: empty output is re-attempted up to MAX_ATTEMPTS.
    respondWithRetryable(null, "   \n  ");

    await expect(invokeAntigravityCli({ ...BASE_INPUT })).rejects.toThrow(
      /empty output/i,
    );
  });

  it("throws AntigravityCliError instances (not bare Error)", async () => {
    respondWithRetryable(null, "");

    await expect(invokeAntigravityCli({ ...BASE_INPUT })).rejects.toBeInstanceOf(
      AntigravityCliError,
    );
  });

  it("closes the child's stdin so `agy --print` does not hang waiting for EOF", async () => {
    respondWith(null, "ok");

    await invokeAntigravityCli({ ...BASE_INPUT });

    expect(lastStdinEnd).toHaveBeenCalledTimes(1);
  });

  it("serialises calls beyond the concurrency cap", async () => {
    // Hold all five calls' callbacks and resolve them after the fact, proving
    // the 5th call queues (cap is 4) until a slot frees up.
    const pending: ExecFileCb[] = [];
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCb) => {
        pending.push(cb);
        return makeFakeChild();
      },
    );

    const flush = async (): Promise<void> => {
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };

    const calls = Array.from({ length: 5 }, () =>
      invokeAntigravityCli({ ...BASE_INPUT }),
    );

    // Allow microtasks to flush; only 4 should have reached execFile (cap=4).
    await flush();
    expect(pending.length).toBe(4);

    // Resolve the first slot — the queued 5th call should now start.
    pending[0]?.(null, "done", "");
    await flush();
    expect(pending.length).toBe(5);

    // Drain remaining callbacks so all promises settle.
    for (let i = 1; i < pending.length; i++) pending[i]?.(null, "done", "");
    await Promise.all(calls);
  });
});
