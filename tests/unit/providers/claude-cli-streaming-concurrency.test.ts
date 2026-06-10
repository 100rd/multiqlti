/**
 * Unit test — streaming spawns honor the ConcurrencyLimiter (streaming-stage-execution, B2).
 *
 * The streaming paths (stream() / streamEvents()) must hold a limiter slot for
 * the FULL lifetime of the async generator: with maxConcurrency = N, only N
 * child processes may be spawned at once; further concurrent streaming stages
 * QUEUE until a slot frees. `node:child_process` is mocked.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { ClaudeCliProvider } from "../../../server/gateway/providers/claude-cli.js";
import type { ProviderMessage } from "../../../shared/types.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: (data: string) => void };
  kill: (signal?: string) => boolean;
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

const USER_MSG: ProviderMessage[] = [{ role: "user", content: "hi" }];

describe("ClaudeCliProvider streaming concurrency (B2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("spawns at most maxConcurrency streaming children at once; the rest queue", async () => {
    const MAX = 2;
    const provider = new ClaudeCliProvider({ maxConcurrency: MAX });
    const children: FakeChild[] = [];

    spawnMock.mockImplementation(() => {
      const child = makeChild();
      children.push(child);
      return child;
    });

    // Start 5 concurrent stream() consumers; do NOT let any finish yet.
    const consumers = Array.from({ length: 5 }, () =>
      (async () => {
        for await (const _c of provider.stream("claude-sonnet", USER_MSG)) {
          void _c;
        }
      })(),
    );

    // Let microtasks settle: acquire() resolves synchronously only for the
    // first MAX; the rest stay queued (no spawn yet).
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(MAX);
    expect(children.length).toBe(MAX);

    // Close the first MAX children → frees slots → queued ones spawn.
    children.slice(0, MAX).forEach((c) => c.emit("close", 0));
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(MAX * 2);

    // Close the rest and the final one to drain.
    children.forEach((c) => c.emit("close", 0));
    await new Promise((r) => setImmediate(r));
    children.forEach((c) => c.emit("close", 0));
    await Promise.all(consumers);
    expect(spawnMock).toHaveBeenCalledTimes(5);
  });

  it("releases the slot when the streaming generator errors", async () => {
    const provider = new ClaudeCliProvider({ maxConcurrency: 1 });
    const c1 = makeChild();
    const c2 = makeChild();
    spawnMock.mockReturnValueOnce(c1).mockReturnValueOnce(c2);

    const first = (async () => {
      for await (const _c of provider.stream("claude-sonnet", USER_MSG)) void _c;
    })();
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // First stream fails (non-zero exit) → must release the slot in finally.
    c1.emit("close", 1);
    await first.catch(() => undefined);

    // A second stream can now spawn (slot was released despite the error).
    const second = (async () => {
      for await (const _c of provider.stream("claude-sonnet", USER_MSG)) void _c;
    })();
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    c2.emit("close", 0);
    await second;
  });
});
