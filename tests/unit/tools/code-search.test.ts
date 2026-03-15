/**
 * Unit tests for the code_search builtin tool.
 *
 * The file system is mocked via vi.mock("fs") so no real disk I/O occurs.
 * Tests verify:
 *   - text search returns matching lines with file:line format
 *   - filename search returns matching paths
 *   - missing workspacePath returns sentinel message
 *   - path traversal (".." components in raw path) is rejected
 *   - null byte in workspacePath is rejected
 *   - results are capped at 20 matches
 *   - files larger than 1 MB are skipped
 *   - non-existent workspacePath returns error message
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

// Mock the 'fs' module before importing the handler
vi.mock("fs");

import { codeSearchHandler } from "../../../server/tools/builtin/code-search.js";

const mockedFs = vi.mocked(fs);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStatDir(): fs.Stats {
  return { isDirectory: () => true, isFile: () => false, size: 0 } as unknown as fs.Stats;
}

function makeStatFile(size = 100): fs.Stats {
  return { isDirectory: () => false, isFile: () => true, size } as unknown as fs.Stats;
}

function makeDirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  } as unknown as fs.Dirent;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("code_search — text search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns matching lines in file:line format", async () => {
    const workspacePath = "/safe/workspace";

    mockedFs.statSync.mockImplementation((p) => {
      if (p === workspacePath) return makeStatDir();
      return makeStatFile(50);
    });

    mockedFs.readdirSync.mockReturnValueOnce([
      makeDirent("index.ts", false),
    ] as unknown as fs.Dirent[]);

    mockedFs.readFileSync.mockReturnValueOnce(
      "line one\nfunction hello() {}\nline three",
    );

    const result = await codeSearchHandler.execute({
      query: "hello",
      workspacePath,
    });

    expect(result).toContain("index.ts");
    expect(result).toContain(":2:");
    expect(result).toContain("function hello()");
  });

  it("returns no-matches message when query is not found", async () => {
    const workspacePath = "/safe/workspace";

    mockedFs.statSync.mockImplementation((p) => {
      if (p === workspacePath) return makeStatDir();
      return makeStatFile(50);
    });
    mockedFs.readdirSync.mockReturnValueOnce([
      makeDirent("index.ts", false),
    ] as unknown as fs.Dirent[]);
    mockedFs.readFileSync.mockReturnValueOnce("nothing relevant here");

    const result = await codeSearchHandler.execute({
      query: "nonexistent_symbol_xyz",
      workspacePath,
    });

    expect(result).toMatch(/no matches found/i);
  });

  it("returns error when workspacePath is not provided", async () => {
    const result = await codeSearchHandler.execute({ query: "hello" });
    expect(result).toMatch(/no workspace path specified/i);
  });

  it("returns error when query is empty", async () => {
    const result = await codeSearchHandler.execute({
      query: "",
      workspacePath: "/any",
    });
    expect(result).toMatch(/query cannot be empty/i);
  });

  it("skips files larger than 1 MB", async () => {
    const workspacePath = "/safe/workspace";

    mockedFs.statSync.mockImplementation((p) => {
      if (p === workspacePath) return makeStatDir();
      // Return a file larger than 1MB
      return makeStatFile(2_000_000);
    });
    mockedFs.readdirSync.mockReturnValueOnce([
      makeDirent("big.ts", false),
    ] as unknown as fs.Dirent[]);

    const result = await codeSearchHandler.execute({
      query: "hello",
      workspacePath,
    });

    expect(result).toMatch(/no matches found/i);
    // readFileSync should NOT have been called for the oversized file
    expect(mockedFs.readFileSync).not.toHaveBeenCalled();
  });

  it("returns at most 20 matches across all files", async () => {
    const workspacePath = "/safe/workspace";

    mockedFs.statSync.mockImplementation((p) => {
      if (p === workspacePath) return makeStatDir();
      return makeStatFile(100);
    });

    // Return 3 files
    mockedFs.readdirSync.mockReturnValueOnce([
      makeDirent("a.ts", false),
      makeDirent("b.ts", false),
      makeDirent("c.ts", false),
    ] as unknown as fs.Dirent[]);

    // Each file has 10 matching lines → 30 total, but max is 20
    const fileContent = Array.from({ length: 10 }, (_, i) => `line${i} match`).join("\n");
    mockedFs.readFileSync.mockReturnValue(fileContent);

    const result = await codeSearchHandler.execute({
      query: "match",
      workspacePath,
    });

    const lines = result.split("\n").filter((l) => l.includes(":"));
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it("returns error message when workspacePath does not exist", async () => {
    mockedFs.statSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = await codeSearchHandler.execute({
      query: "hello",
      workspacePath: "/nonexistent/path",
    });

    expect(result).toMatch(/invalid workspace path|does not exist/i);
  });
});

describe("code_search — filename search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns files whose names match the query", async () => {
    const workspacePath = "/safe/workspace";

    mockedFs.statSync.mockImplementation((p) => {
      if (p === workspacePath) return makeStatDir();
      return makeStatFile(50);
    });
    mockedFs.readdirSync.mockReturnValueOnce([
      makeDirent("auth.service.ts", false),
      makeDirent("user.model.ts", false),
      makeDirent("auth.guard.ts", false),
    ] as unknown as fs.Dirent[]);

    const result = await codeSearchHandler.execute({
      query: "auth",
      type: "filename",
      workspacePath,
    });

    expect(result).toContain("auth.service.ts");
    expect(result).toContain("auth.guard.ts");
    expect(result).not.toContain("user.model.ts");
  });

  it("skips hidden files and node_modules", async () => {
    const workspacePath = "/safe/workspace";

    mockedFs.statSync.mockImplementation((p) => {
      if (p === workspacePath) return makeStatDir();
      return makeStatFile(50);
    });
    // readdirSync returns hidden dir and node_modules — both skipped
    mockedFs.readdirSync.mockReturnValueOnce([
      makeDirent(".git", true),
      makeDirent("node_modules", true),
      makeDirent("index.ts", false),
    ] as unknown as fs.Dirent[]);

    const result = await codeSearchHandler.execute({
      query: "index",
      type: "filename",
      workspacePath,
    });

    expect(result).toContain("index.ts");
    expect(result).not.toContain(".git");
    expect(result).not.toContain("node_modules");
  });
});

describe("code_search — tool definition", () => {
  it("has correct name and source", () => {
    expect(codeSearchHandler.definition.name).toBe("code_search");
    expect(codeSearchHandler.definition.source).toBe("builtin");
  });

  it("requires query field", () => {
    const schema = codeSearchHandler.definition.inputSchema as {
      required: string[];
    };
    expect(schema.required).toContain("query");
  });
});

// ─── Path traversal prevention ─────────────────────────────────────────────────

describe("code_search — path traversal prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects '../secret' style workspacePath (relative traversal)", async () => {
    const result = await codeSearchHandler.execute({
      query: "root",
      workspacePath: "../secret",
    });
    expect(result).toMatch(/path traversal|invalid workspace path/i);
  });

  it("rejects '/safe/../../etc' style workspacePath (absolute with traversal)", async () => {
    const result = await codeSearchHandler.execute({
      query: "root",
      workspacePath: "/safe/../../etc",
    });
    expect(result).toMatch(/path traversal|invalid workspace path/i);
  });

  it("rejects '../../etc/passwd' style workspacePath", async () => {
    const result = await codeSearchHandler.execute({
      query: "root",
      workspacePath: "../../etc",
    });
    expect(result).toMatch(/path traversal|invalid workspace path/i);
  });

  it("rejects workspacePath with embedded null byte", async () => {
    const result = await codeSearchHandler.execute({
      query: "root",
      workspacePath: "/safe\x00/injected",
    });
    expect(result).toMatch(/invalid workspace path/i);
  });

  it("does not return a traversal error for safe absolute workspace paths", async () => {
    const workspacePath = "/safe/workspace";
    mockedFs.statSync.mockImplementation((p) => {
      if (String(p) === workspacePath) return makeStatDir();
      return makeStatFile(50);
    });
    mockedFs.readdirSync.mockReturnValueOnce([] as unknown as fs.Dirent[]);

    const result = await codeSearchHandler.execute({
      query: "hello",
      workspacePath,
    });

    // The result is "no matches" (empty dir) — NOT a traversal/invalid-path error
    expect(result).not.toMatch(/path traversal|invalid workspace path/i);
    expect(result).toMatch(/no matches found/i);
  });
});
