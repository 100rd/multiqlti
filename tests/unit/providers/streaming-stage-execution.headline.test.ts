/**
 * HEADLINE deterministic test (streaming-stage-execution, T17 / PR gate).
 *
 * Proves the old 120s blocking wall-clock cap is GONE: a streamed stage call
 * that runs for ~599s of virtual time — emitting a chunk inside every idle
 * window — COMPLETES. Driven entirely by vi.useFakeTimers + advanceTimersByTimeAsync
 * (no real CLI, no real wall-clock). Companion: a genuine stall (no output past
 * the idle window) FAILS with the idle-timeout error.
 *
 * Exercises the REAL idle/overall timer logic in streamCliLines via the
 * ClaudeCliProvider.stream() path with node:child_process mocked.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { ClaudeCliProvider } from "../../../server/gateway/providers/claude-cli.js";
import { CliIdleTimeoutError } from "../../../server/gateway/providers/cli-spawn.js";
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

function assistantLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
}

const USER_MSG: ProviderMessage[] = [{ role: "user", content: "long planning prompt" }];

const IDLE_MS = 60_000; // 60s idle window
const OVERALL_MS = 600_000; // 10 min overall cap
const CHUNK_EVERY_MS = 50_000; // < idle window, so idle never fires
const TOTAL_VIRTUAL_MS = 599_000; // ~599s — far beyond the old 120s cap

describe("HEADLINE: a >120s streamed stage completes (idle-reset beats old cap)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("completes a ~599s stream that emits a chunk inside every idle window", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => child);
    const provider = new ClaudeCliProvider();

    const chunks: string[] = [];
    const consume = (async () => {
      for await (const chunk of provider.stream("claude-sonnet", USER_MSG, {
        idleTimeoutMs: IDLE_MS,
        timeoutMs: OVERALL_MS,
      })) {
        chunks.push(chunk);
      }
    })();

    // Emit growing assistant text every CHUNK_EVERY_MS for ~599s of virtual time.
    let accumulated = "";
    let n = 0;
    for (let t = CHUNK_EVERY_MS; t <= TOTAL_VIRTUAL_MS; t += CHUNK_EVERY_MS) {
      n += 1;
      accumulated += `tok${n} `;
      child.stdout.emit("data", Buffer.from(assistantLine(accumulated)));
      await vi.advanceTimersByTimeAsync(CHUNK_EVERY_MS);
    }
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(0);
    await consume;

    // Stream completed (no throw) and produced incremental deltas across >120s.
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join("")).toContain("tok1");
    // Crucially: the child was NEVER killed (no timeout fired).
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("COMPANION: a genuine stall past the idle window fails with the idle-timeout error", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => child); // silent — no chunks ever
    const provider = new ClaudeCliProvider();

    const consume = (async () => {
      for await (const _chunk of provider.stream("claude-sonnet", USER_MSG, {
        idleTimeoutMs: IDLE_MS,
        timeoutMs: OVERALL_MS,
      })) {
        void _chunk;
      }
    })();

    const expectation = expect(consume).rejects.toBeInstanceOf(CliIdleTimeoutError);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    await expectation;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
