/**
 * Unit tests for FileWatcher (Issue #284)
 *
 * Chokidar is mocked — we test the debounce logic, gitignore parsing,
 * ignore-list building, and lifecycle (start/stop) without touching the
 * real filesystem or setting up a real watcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";

// ─── Mock chokidar ────────────────────────────────────────────────────────────

import { EventEmitter } from "events";

class MockWatcher extends EventEmitter {
  public closeCalled = false;
  async close() {
    this.closeCalled = true;
  }
}

let latestMockWatcher: MockWatcher;

vi.mock("chokidar", () => {
  return {
    default: {
      watch: vi.fn((_path: string, _opts: unknown) => {
        latestMockWatcher = new MockWatcher();
        return latestMockWatcher;
      }),
    },
  };
});

// ─── Mock fs/promises ─────────────────────────────────────────────────────────

let gitignoreContent: string | null = null;

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (p.endsWith(".gitignore")) {
        if (gitignoreContent === null) throw new Error("ENOENT");
        return gitignoreContent;
      }
      throw new Error("ENOENT");
    }),
    readdir: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 0 })),
    mkdir: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
    appendFile: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  },
}));

import {
  FileWatcher,
  readGitignorePatterns,
  buildIgnoredList,
  DEFAULT_DEBOUNCE_MS,
  MAX_QUEUE_SIZE,
} from "../../../server/workspace/file-watcher.js";

const ROOT = "/workspace/test";

describe("readGitignorePatterns", () => {
  beforeEach(() => {
    gitignoreContent = null;
  });

  it("1. returns empty array when .gitignore is absent", async () => {
    gitignoreContent = null;
    const patterns = await readGitignorePatterns(ROOT);
    expect(patterns).toEqual([]);
  });

  it("2. parses non-empty .gitignore, skipping comments and blank lines", async () => {
    gitignoreContent = `
# This is a comment
dist/
*.log

build/
  `.trim();
    const patterns = await readGitignorePatterns(ROOT);
    expect(patterns).toContain("dist/");
    expect(patterns).toContain("*.log");
    expect(patterns).toContain("build/");
    expect(patterns.some((p) => p.startsWith("#"))).toBe(false);
    expect(patterns.some((p) => p === "")).toBe(false);
  });

  it("3. handles CRLF line endings", async () => {
    gitignoreContent = "node_modules\r\ndist\r\n";
    const patterns = await readGitignorePatterns(ROOT);
    expect(patterns).toContain("node_modules");
    expect(patterns).toContain("dist");
  });
});

describe("buildIgnoredList", () => {
  it("4. always includes SKIP_DIRS as regex patterns", () => {
    const ignored = buildIgnoredList(ROOT, [], []);
    const patterns = ignored.map((p) => String(p));
    // node_modules and .git should always be ignored
    expect(patterns.some((p) => p.includes("node_modules"))).toBe(true);
    expect(patterns.some((p) => p.includes("\\.git"))).toBe(true);
  });

  it("5. includes gitignore patterns as path strings", () => {
    const ignored = buildIgnoredList(ROOT, ["/dist"], []);
    const strings = ignored.filter((p) => typeof p === "string") as string[];
    expect(strings.some((s) => s.includes("dist"))).toBe(true);
  });

  it("6. includes extra patterns", () => {
    const ignored = buildIgnoredList(ROOT, [], ["*.test.ts"]);
    const patterns = ignored.map((p) => String(p));
    expect(patterns.some((p) => p.includes("test"))).toBe(true);
  });

  it("7. negation patterns (!) are skipped", () => {
    // Negation is complex — we skip it safely
    const ignored = buildIgnoredList(ROOT, ["!important.ts"], []);
    const patterns = ignored.map((p) => String(p));
    expect(patterns.some((p) => p.includes("important"))).toBe(false);
  });
});

describe("FileWatcher lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gitignoreContent = null;
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("8. starts and creates a chokidar watcher", async () => {
    const flush = vi.fn();
    const watcher = new FileWatcher(ROOT, flush);
    await watcher.start();
    expect(watcher.isRunning).toBe(true);
    await watcher.stop();
  });

  it("9. isRunning is false before start and after stop", async () => {
    const flush = vi.fn();
    const watcher = new FileWatcher(ROOT, flush);
    expect(watcher.isRunning).toBe(false);
    await watcher.start();
    expect(watcher.isRunning).toBe(true);
    await watcher.stop();
    expect(watcher.isRunning).toBe(false);
  });

  it("10. calling start twice is a no-op", async () => {
    const flush = vi.fn();
    const watcher = new FileWatcher(ROOT, flush);
    await watcher.start();
    await watcher.start(); // second call — should not throw
    expect(watcher.isRunning).toBe(true);
    await watcher.stop();
  });

  it("11. calling stop when not running is a no-op", async () => {
    const flush = vi.fn();
    const watcher = new FileWatcher(ROOT, flush);
    await expect(watcher.stop()).resolves.toBeUndefined();
  });

  it("12. debounce: single event triggers flush after delay", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const watcher = new FileWatcher(ROOT, flush, { debounceMs: 100 });
    await watcher.start();

    latestMockWatcher.emit("change", `${ROOT}/src/index.ts`);
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    await Promise.resolve(); // flush microtask queue

    expect(flush).toHaveBeenCalledOnce();
    const events = flush.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("change");
    expect(events[0].relativePath).toBe("src/index.ts");

    await watcher.stop();
  });

  it("13. debounce: burst of events collapses into one flush", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const watcher = new FileWatcher(ROOT, flush, { debounceMs: 200 });
    await watcher.start();

    // Emit 5 changes to the same file quickly
    latestMockWatcher.emit("change", `${ROOT}/src/a.ts`);
    latestMockWatcher.emit("change", `${ROOT}/src/a.ts`);
    latestMockWatcher.emit("change", `${ROOT}/src/a.ts`);
    latestMockWatcher.emit("change", `${ROOT}/src/b.ts`);
    latestMockWatcher.emit("change", `${ROOT}/src/b.ts`);

    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await Promise.resolve();

    // One flush, deduplicated: a.ts and b.ts (last event wins)
    expect(flush).toHaveBeenCalledOnce();
    const events = flush.mock.calls[0][0];
    expect(events.length).toBe(2);

    await watcher.stop();
  });

  it("14. unlink events pass through regardless of extension", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const watcher = new FileWatcher(ROOT, flush, { debounceMs: 50 });
    await watcher.start();

    latestMockWatcher.emit("unlink", `${ROOT}/src/old.ts`);

    vi.advanceTimersByTime(100);
    await Promise.resolve();

    expect(flush).toHaveBeenCalledOnce();
    const events = flush.mock.calls[0][0];
    expect(events[0].kind).toBe("unlink");

    await watcher.stop();
  });

  it("15. non-indexable extension events are ignored", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const watcher = new FileWatcher(ROOT, flush, { debounceMs: 50 });
    await watcher.start();

    // .css and .md files should be ignored
    latestMockWatcher.emit("change", `${ROOT}/src/styles.css`);
    latestMockWatcher.emit("change", `${ROOT}/README.md`);

    vi.advanceTimersByTime(100);
    await Promise.resolve();

    // Flush was not called because no events passed the filter
    expect(flush).not.toHaveBeenCalled();

    await watcher.stop();
  });

  it("16. add event triggers flush with kind=add", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const watcher = new FileWatcher(ROOT, flush, { debounceMs: 50 });
    await watcher.start();

    latestMockWatcher.emit("add", `${ROOT}/src/new.ts`);

    vi.advanceTimersByTime(100);
    await Promise.resolve();

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0][0][0].kind).toBe("add");

    await watcher.stop();
  });

  it("17. flush error does not crash the watcher", async () => {
    const flush = vi.fn().mockRejectedValue(new Error("Flush failed"));
    const watcher = new FileWatcher(ROOT, flush, { debounceMs: 50 });
    await watcher.start();

    latestMockWatcher.emit("change", `${ROOT}/src/index.ts`);

    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve(); // extra tick for the rejection

    // Watcher should still be running
    expect(watcher.isRunning).toBe(true);

    await watcher.stop();
  });

  it("18. pendingCount reflects queued events before flush", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const watcher = new FileWatcher(ROOT, flush, { debounceMs: 5000 });
    await watcher.start();

    latestMockWatcher.emit("change", `${ROOT}/src/a.ts`);
    latestMockWatcher.emit("change", `${ROOT}/src/b.ts`);

    expect(watcher.pendingCount).toBe(2);

    await watcher.stop();
  });

  it("19. MAX_QUEUE_SIZE overflow triggers immediate flush", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const watcher = new FileWatcher(ROOT, flush, { debounceMs: 60000 });
    await watcher.start();

    // Emit MAX_QUEUE_SIZE + 1 unique files to trigger immediate flush
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      latestMockWatcher.emit("change", `${ROOT}/src/file${i}.ts`);
    }

    // Let microtasks run
    await Promise.resolve();
    await Promise.resolve();

    expect(flush).toHaveBeenCalled();

    await watcher.stop();
  });

  it("20. DEFAULT_DEBOUNCE_MS is 300", () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(300);
  });
});
