/**
 * Unit tests for server/services/consilium/repo-conventions.ts — reads a workspace
 * repo's convention file (`AGENTS.md`, falling back to `CLAUDE.md`) for the consilium
 * loop's REVIEW and DEV (coder) stages. Uses REAL files under a temp dir (mkdtempSync)
 * rather than mocking fs, since the module's own statSync/readFileSync ordering is
 * part of its contract. Covers:
 *   - AGENTS.md preferred over CLAUDE.md when both exist (never concatenated).
 *   - CLAUDE.md fallback when only it exists.
 *   - neither present ⇒ null.
 *   - oversize file ⇒ clamped to the byte budget + an omission note appended.
 *   - content is fenced (backtick-delimited) and secret-redacted.
 *   - never throws on a bad/missing directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readConventionsFile } from "../../../server/services/consilium/repo-conventions.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "repo-conventions-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readConventionsFile — preference order", () => {
  it("prefers AGENTS.md over CLAUDE.md when both exist (never concatenated)", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Agents rules here.");
    writeFileSync(join(dir, "CLAUDE.md"), "Claude rules here.");
    const result = readConventionsFile(dir, 8_000);
    expect(result).not.toBeNull();
    expect(result).toContain("Agents rules here.");
    expect(result).not.toContain("Claude rules here.");
  });

  it("falls back to CLAUDE.md when AGENTS.md is absent", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "Claude rules here.");
    const result = readConventionsFile(dir, 8_000);
    expect(result).not.toBeNull();
    expect(result).toContain("Claude rules here.");
  });

  it("returns null when neither file is present", () => {
    const result = readConventionsFile(dir, 8_000);
    expect(result).toBeNull();
  });
});

describe("readConventionsFile — byte budget", () => {
  it("clamps an oversized file to the budget and appends an omission note", () => {
    const big = "x".repeat(5_000);
    writeFileSync(join(dir, "AGENTS.md"), big);
    const result = readConventionsFile(dir, 100);
    expect(result).not.toBeNull();
    expect(result).toContain("truncated to the configured byte budget");
    // The full 5000-char body must NOT be present verbatim (it was clamped).
    expect(result).not.toContain(big);
  });

  it("does not clamp / add a note when the file is within budget", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Small conventions file.");
    const result = readConventionsFile(dir, 8_000);
    expect(result).not.toBeNull();
    expect(result).not.toContain("truncated to the configured byte budget");
  });
});

describe("readConventionsFile — fenced + secret-redacted", () => {
  it("wraps the content in a matching backtick fence", () => {
    writeFileSync(join(dir, "AGENTS.md"), "Some conventions.");
    const result = readConventionsFile(dir, 8_000);
    expect(result).not.toBeNull();
    const fenceMatch = result!.match(/^(`{3,})/);
    expect(fenceMatch).not.toBeNull();
    const fence = fenceMatch![1];
    // starts AND ends with the same fence.
    expect(result!.startsWith(fence)).toBe(true);
    expect(result!.trim().endsWith(fence)).toBe(true);
  });

  it("redacts a secret embedded in the convention file before returning", () => {
    const secret = "AKIAIOSFODNN7EXAMPLEKEYDATA1234567890";
    writeFileSync(join(dir, "AGENTS.md"), `Use this key: AWS_SECRET_ACCESS_KEY=${secret}`);
    const result = readConventionsFile(dir, 8_000);
    expect(result).not.toBeNull();
    expect(result).not.toContain(secret);
    expect(result).toContain("<REDACTED:");
  });
});

describe("readConventionsFile — never throws", () => {
  it("returns null (never throws) for a non-existent directory", () => {
    expect(() => readConventionsFile(join(dir, "does-not-exist"), 8_000)).not.toThrow();
    expect(readConventionsFile(join(dir, "does-not-exist"), 8_000)).toBeNull();
  });

  it("returns null (never throws) for a nonsense path", () => {
    expect(() => readConventionsFile("\0invalid", 8_000)).not.toThrow();
    expect(readConventionsFile("\0invalid", 8_000)).toBeNull();
  });
});
