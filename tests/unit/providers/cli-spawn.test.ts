/**
 * Unit tests for the shared cli-spawn helper: timeout, AbortSignal cancellation,
 * concurrency cap, ENOENT handling, and JSONL line streaming.
 *
 * `node:child_process` is fully mocked — no real process is launched.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
  spawnCli,
  streamCliLines,
  ConcurrencyLimiter,
  CliNotInstalledError,
  CliExecutionError,
  CliIdleTimeoutError,
  CliOverallTimeoutError,
  CliByteCapError,
  CliLineCapError,
  CliAbortError,
} from "../../../server/gateway/providers/cli-spawn.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.stdin = { end: vi.fn() };
  return child;
}

const REQ = { binary: "claude", args: ["-p"], stdin: "hi" } as const;

const NL = "\n";

/** Drain a generator to completion, collecting yielded lines. */
async function drain(gen: AsyncGenerator<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of gen) lines.push(line);
  return lines;
}

describe("spawnCli", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("resolves with buffered stdout on a clean exit", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("hello"));
        child.emit("close", 0);
      });
      return child;
    });

    const result = await spawnCli({ ...REQ });
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("writes stdin and closes it exactly once", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => child.emit("close", 0));
      return child;
    });

    await spawnCli({ ...REQ, stdin: "payload" });
    expect(child.stdin.end).toHaveBeenCalledWith("payload");
  });

  it("maps ENOENT to CliNotInstalledError", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() =>
        child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      );
      return child;
    });

    await expect(spawnCli({ ...REQ })).rejects.toBeInstanceOf(CliNotInstalledError);
  });

  it("rejects with CliExecutionError including stderr on non-zero exit", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("bad input"));
        child.emit("close", 2);
      });
      return child;
    });

    await expect(spawnCli({ ...REQ })).rejects.toThrow(/bad input|code 2/);
  });

  it("kills the child and rejects on timeout", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockImplementation(() => child); // never emits close

    const promise = spawnCli({ ...REQ, timeoutMs: 1000 });
    const expectation = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1001);
    await expectation;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills the child and rejects when the AbortSignal fires", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => child);
    const controller = new AbortController();

    const promise = spawnCli({ ...REQ, signal: controller.signal });
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates SIGTERM to SIGKILL on abort (C3)", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockImplementation(() => child);
    const controller = new AbortController();

    const promise = spawnCli({ ...REQ, signal: controller.signal });
    const expectation = expect(promise).rejects.toThrow(/aborted/i);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_001);
    await expectation;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("keeps the 120s default timeout (regression — short callers, H2)", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockImplementation(() => child); // never emits close
    const promise = spawnCli({ ...REQ });
    const expectation = expect(promise).rejects.toThrow(/timed out after 120000ms/);
    await vi.advanceTimersByTimeAsync(120_001);
    await expectation;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("streamCliLines", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("yields complete lines split on newlines, including a trailing partial", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("a" + NL + "b" + NL + "c"));
        child.emit("close", 0);
      });
      return child;
    });

    expect(await drain(streamCliLines({ ...REQ }))).toEqual(["a", "b", "c"]);
  });

  it("throws CliExecutionError on a non-zero exit after streaming", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("partial" + NL));
        child.stderr.emit("data", Buffer.from("oops"));
        child.emit("close", 1);
      });
      return child;
    });
    await expect(drain(streamCliLines({ ...REQ }))).rejects.toBeInstanceOf(CliExecutionError);
  });

  // ── Idle timeout (H1) ──────────────────────────────────────────────────────
  it("fires the idle timeout when no data arrives within the window", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockImplementation(() => child); // silent, never closes
    const gen = streamCliLines({ ...REQ, idleTimeoutMs: 5_000, timeoutMs: 600_000 });
    const expectation = expect(drain(gen)).rejects.toBeInstanceOf(CliIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(5_001);
    await expectation;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("resets the idle timer on each chunk so a slow-but-progressing stream survives past 120s (H1)", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockImplementation(() => child);
    const gen = streamCliLines({ ...REQ, idleTimeoutMs: 5_000, timeoutMs: 600_000 });
    const collected: string[] = [];
    const consume = (async () => {
      for await (const line of gen) collected.push(line);
    })();
    // Emit a line every 4s (< 5s idle) for 130s total — well past the old 120s cap.
    for (let t = 0; t < 130_000; t += 4_000) {
      child.stdout.emit("data", Buffer.from("line" + String(t) + NL));
      await vi.advanceTimersByTimeAsync(4_000);
    }
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    await consume;
    expect(collected.length).toBeGreaterThan(30);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  // ── Overall cap (H1): fires despite continuous chunks ───────────────────────
  it("fires the overall cap even while chunks keep arriving (H1)", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockImplementation(() => child);
    const gen = streamCliLines({ ...REQ, idleTimeoutMs: 60_000, timeoutMs: 20_000 });
    const collected: string[] = [];
    let caught: unknown = null;
    const consume = (async () => {
      try {
        for await (const line of gen) collected.push(line);
      } catch (e) {
        caught = e;
      }
    })();
    // Chunk every 2s (idle never fires) but overall cap is 20s.
    for (let t = 0; t < 30_000; t += 2_000) {
      child.stdout.emit("data", Buffer.from("c" + String(t) + NL));
      await vi.advanceTimersByTimeAsync(2_000);
    }
    await consume;
    expect(caught).toBeInstanceOf(CliOverallTimeoutError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // ── Byte cap (C2/H4) ────────────────────────────────────────────────────────
  it("kills + fails with CliByteCapError when cumulative stdout exceeds maxOutputBytes", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("x".repeat(50) + NL));
        child.stdout.emit("data", Buffer.from("y".repeat(50) + NL));
      });
      return child;
    });
    await expect(
      drain(streamCliLines({ ...REQ, maxOutputBytes: 64 })),
    ).rejects.toBeInstanceOf(CliByteCapError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // ── Line cap (H4): no-newline flood ─────────────────────────────────────────
  it("kills + fails with CliLineCapError when a single line exceeds the max line length", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        // No newline — would grow the buffer unboundedly.
        child.stdout.emit("data", Buffer.from("z".repeat(200)));
      });
      return child;
    });
    await expect(
      drain(streamCliLines({ ...REQ, maxLineBytes: 100 })),
    ).rejects.toBeInstanceOf(CliLineCapError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  // ── Abort (C3) ──────────────────────────────────────────────────────────────
  it("kills + fails with CliAbortError when the AbortSignal fires, escalating to SIGKILL", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    spawnMock.mockImplementation(() => child);
    const controller = new AbortController();
    const gen = streamCliLines({ ...REQ, signal: controller.signal, timeoutMs: 600_000 });
    const expectation = expect(drain(gen)).rejects.toBeInstanceOf(CliAbortError);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_001);
    await expectation;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  // ── Single settle / cleanup (C2): no leaked listeners/timers ─────────────────
  it("settles exactly once and removes the abort listener on normal close", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    spawnMock.mockImplementation(() => child);

    const collected: string[] = [];
    const consume = (async () => {
      for await (const line of streamCliLines({
        ...REQ,
        signal: controller.signal,
        idleTimeoutMs: 5_000,
        timeoutMs: 600_000,
      })) {
        collected.push(line);
      }
    })();

    // Emit a line then close on the SAME child (generator already attached).
    child.stdout.emit("data", Buffer.from("ok" + NL));
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    await consume;

    expect(collected).toEqual(["ok"]);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    // No pending idle/overall timer should fire post-settle (would re-kill).
    child.kill.mockClear();
    await vi.advanceTimersByTimeAsync(600_001);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("maps ENOENT to CliNotInstalledError", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() =>
        child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      );
      return child;
    });
    await expect(drain(streamCliLines({ ...REQ }))).rejects.toBeInstanceOf(CliNotInstalledError);
  });
});

describe("ConcurrencyLimiter", () => {
  it("never runs more than `max` tasks at once", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;

    const task = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active -= 1;
    };

    await Promise.all(Array.from({ length: 6 }, () => limiter.run(task)));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("releases a slot even when a task throws", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });
});
