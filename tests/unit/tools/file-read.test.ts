/**
 * Unit tests for the file_read builtin tool.
 *
 * The file system is mocked via vi.mock("fs") so no real disk I/O occurs.
 * Tests verify:
 *   - reads full file content
 *   - respects startLine/endLine range
 *   - rejects empty path
 *   - rejects path traversal (".." sequences)
 *   - rejects null bytes in path
 *   - returns error for non-existent files
 *   - returns error for files exceeding 500 KB
 *   - returns error for non-regular files (directories)
 *   - returns error when startLine exceeds file length
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

vi.mock("fs");

import { fileReadHandler } from "../../../server/tools/builtin/file-read.js";

const mockedFs = vi.mocked(fs);

function makeStatFile(size = 100): fs.Stats {
  return { isFile: () => true, isDirectory: () => false, size } as unknown as fs.Stats;
}

function makeStatDir(): fs.Stats {
  return { isFile: () => false, isDirectory: () => true, size: 0 } as unknown as fs.Stats;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("file_read — full file content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns full file content when no line range specified", async () => {
    mockedFs.statSync.mockReturnValue(makeStatFile(50));
    mockedFs.readFileSync.mockReturnValue("line1\nline2\nline3");

    const result = await fileReadHandler.execute({ path: "/safe/file.ts" });

    expect(result).toBe("line1\nline2\nline3");
  });

  it("returns error for empty path", async () => {
    const result = await fileReadHandler.execute({ path: "" });
    expect(result).toMatch(/path cannot be empty/i);
  });

  it("returns error for non-existent file", async () => {
    mockedFs.statSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = await fileReadHandler.execute({ path: "/nonexistent/file.ts" });
    expect(result).toMatch(/file not found/i);
  });

  it("returns error for directory path", async () => {
    mockedFs.statSync.mockReturnValue(makeStatDir());

    const result = await fileReadHandler.execute({ path: "/some/directory" });
    expect(result).toMatch(/not a regular file/i);
  });

  it("returns error when file exceeds 500 KB", async () => {
    mockedFs.statSync.mockReturnValue(makeStatFile(600_000));

    const result = await fileReadHandler.execute({ path: "/large/file.ts" });
    expect(result).toMatch(/file too large/i);
  });
});

describe("file_read — line range", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only the specified line range (1-indexed, inclusive)", async () => {
    mockedFs.statSync.mockReturnValue(makeStatFile(100));
    mockedFs.readFileSync.mockReturnValue("line1\nline2\nline3\nline4\nline5");

    const result = await fileReadHandler.execute({
      path: "/safe/file.ts",
      startLine: 2,
      endLine: 4,
    });

    expect(result).toBe("line2\nline3\nline4");
  });

  it("returns from startLine to end of file when endLine is omitted", async () => {
    mockedFs.statSync.mockReturnValue(makeStatFile(100));
    mockedFs.readFileSync.mockReturnValue("a\nb\nc\nd");

    const result = await fileReadHandler.execute({
      path: "/safe/file.ts",
      startLine: 3,
    });

    expect(result).toBe("c\nd");
  });

  it("returns error when startLine exceeds file length", async () => {
    mockedFs.statSync.mockReturnValue(makeStatFile(100));
    mockedFs.readFileSync.mockReturnValue("line1\nline2");

    const result = await fileReadHandler.execute({
      path: "/safe/file.ts",
      startLine: 99,
      endLine: 100,
    });

    expect(result).toMatch(/startLine \d+ exceeds file length/i);
  });

  it("returns single line when startLine equals endLine", async () => {
    mockedFs.statSync.mockReturnValue(makeStatFile(100));
    mockedFs.readFileSync.mockReturnValue("line1\nline2\nline3");

    const result = await fileReadHandler.execute({
      path: "/safe/file.ts",
      startLine: 2,
      endLine: 2,
    });

    expect(result).toBe("line2");
  });
});

describe("file_read — path traversal prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects path with '..' sequences", async () => {
    const result = await fileReadHandler.execute({ path: "../etc/passwd" });
    expect(result).toMatch(/path traversal|invalid path/i);
  });

  it("rejects path with embedded '..'", async () => {
    const result = await fileReadHandler.execute({ path: "/safe/../../etc/passwd" });
    // path.normalize("/safe/../../etc/passwd") = "../etc/passwd" which contains ".."
    expect(result).toMatch(/path traversal|invalid path/i);
  });

  it("rejects path with null byte", async () => {
    const result = await fileReadHandler.execute({ path: "/safe/file\x00.ts" });
    expect(result).toMatch(/null bytes|invalid path/i);
  });

  it("allows normal absolute paths", async () => {
    mockedFs.statSync.mockReturnValue(makeStatFile(50));
    mockedFs.readFileSync.mockReturnValue("safe content");

    const result = await fileReadHandler.execute({ path: "/safe/normal/file.ts" });
    expect(result).toBe("safe content");
  });
});

describe("file_read — tool definition", () => {
  it("has correct name and source", () => {
    expect(fileReadHandler.definition.name).toBe("file_read");
    expect(fileReadHandler.definition.source).toBe("builtin");
  });

  it("requires path field", () => {
    const schema = fileReadHandler.definition.inputSchema as { required: string[] };
    expect(schema.required).toContain("path");
  });
});
