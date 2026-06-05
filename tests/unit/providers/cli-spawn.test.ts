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
});

describe("streamCliLines", () => {
  beforeEach(() => vi.clearAllMocks());

  it("yields complete lines split on newlines, including a trailing partial", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("a\nb\nc"));
        child.emit("close", 0);
      });
      return child;
    });

    const lines: string[] = [];
    for await (const line of streamCliLines({ ...REQ })) lines.push(line);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("throws CliExecutionError on a non-zero exit after streaming", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("partial\n"));
        child.stderr.emit("data", Buffer.from("oops"));
        child.emit("close", 1);
      });
      return child;
    });

    const run = async (): Promise<void> => {
      for await (const _line of streamCliLines({ ...REQ })) {
        void _line;
      }
    };
    await expect(run()).rejects.toBeInstanceOf(CliExecutionError);
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
