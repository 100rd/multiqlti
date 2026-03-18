/**
 * Unit tests for server/pipeline/complexity-estimator.ts
 *
 * Covers:
 *  - estimateTokenCount: character-to-token approximation
 *  - countFileReferences: unique file-path detection
 *  - countTestReferences: test-case / test-file detection
 *  - estimateComplexity: composite scoring
 *  - computeShardCount: formula + edge cases
 */
import { describe, it, expect } from "vitest";
import {
  estimateTokenCount,
  countFileReferences,
  countTestReferences,
  estimateComplexity,
  computeShardCount,
  DEFAULT_SHARD_TARGET_SIZE,
} from "../../../server/pipeline/complexity-estimator.js";

// ─── estimateTokenCount ───────────────────────────────────────────────────────

describe("estimateTokenCount", () => {
  it("returns 1 for a 4-char string", () => {
    expect(estimateTokenCount("abcd")).toBe(1);
  });

  it("rounds up for non-multiple of 4", () => {
    expect(estimateTokenCount("abc")).toBe(1);  // ceil(3/4)=1
    expect(estimateTokenCount("abcde")).toBe(2); // ceil(5/4)=2
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("handles large strings correctly", () => {
    const text = "a".repeat(4000);
    expect(estimateTokenCount(text)).toBe(1000);
  });
});

// ─── countFileReferences ──────────────────────────────────────────────────────

describe("countFileReferences", () => {
  it("returns 0 when no files are mentioned", () => {
    expect(countFileReferences("do some work please")).toBe(0);
  });

  it("counts a single file reference", () => {
    expect(countFileReferences("update ./src/index.ts to export the new helper")).toBe(1);
  });

  it("counts multiple unique file references", () => {
    const text = "modify server/routes.ts and client/app.tsx, also update shared/types.ts";
    expect(countFileReferences(text)).toBeGreaterThanOrEqual(3);
  });

  it("deduplicates the same file mentioned twice", () => {
    const text = "server/index.ts is broken, please fix server/index.ts";
    expect(countFileReferences(text)).toBe(1);
  });

  it("counts multiple extensions: .py, .go, .json", () => {
    const text = "edit app.py and router.go, update config.json";
    expect(countFileReferences(text)).toBe(3);
  });
});

// ─── countTestReferences ─────────────────────────────────────────────────────

describe("countTestReferences", () => {
  it("returns 0 for plain prose", () => {
    expect(countTestReferences("implement a new feature")).toBe(0);
  });

  it("counts describe() and it() blocks", () => {
    const text = `
      describe('UserService', () => {
        it('creates a user', ...);
        it('deletes a user', ...);
      });
    `;
    expect(countTestReferences(text)).toBe(3); // 1 describe + 2 it
  });

  it("counts test() calls", () => {
    const text = "test('should work', () => {}) and test('other case', () => {})";
    expect(countTestReferences(text)).toBe(2);
  });

  it("counts Python def test_ functions", () => {
    const text = "def test_create_user(): ... def test_delete_user(): ...";
    expect(countTestReferences(text)).toBe(2);
  });

  it("counts Go Test functions", () => {
    const text = "func TestCreateUser(t *testing.T) {} func TestDeleteUser(t *testing.T) {}";
    expect(countTestReferences(text)).toBe(2);
  });

  it("counts .test.ts and .spec.ts filenames uniquely", () => {
    const text = "run user.test.ts and auth.spec.ts, also user.test.ts again";
    expect(countTestReferences(text)).toBe(2); // deduped
  });
});

// ─── estimateComplexity ───────────────────────────────────────────────────────

describe("estimateComplexity", () => {
  it("returns zero counts for empty string", () => {
    const result = estimateComplexity("");
    expect(result.inputTokens).toBe(0);
    expect(result.fileCount).toBe(0);
    expect(result.testCount).toBe(0);
    expect(result.score).toBe(0);
  });

  it("produces higher score for input with many file refs", () => {
    const withFiles = "update src/a.ts and src/b.ts and src/c.ts and src/d.ts and src/e.ts";
    const withoutFiles = "do some general work here without any specific file references needed";
    const scoreWithFiles = estimateComplexity(withFiles).score;
    const scoreWithout = estimateComplexity(withoutFiles).score;
    expect(scoreWithFiles).toBeGreaterThan(scoreWithout);
  });

  it("produces higher score for input with many test refs", () => {
    const withTests = "run describe('suite', () => { it('a', ...); it('b', ...); it('c', ...); })";
    const plain = "implement the feature logic now for the given requirements you have";
    expect(estimateComplexity(withTests).score).toBeGreaterThan(estimateComplexity(plain).score);
  });

  it("score is the sum of weighted components", () => {
    const result = estimateComplexity("abcd"); // 1 token, 0 files, 0 tests
    expect(result.score).toBe(result.inputTokens * 1 + result.fileCount * 50 + result.testCount * 30);
  });
});

// ─── computeShardCount ───────────────────────────────────────────────────────

describe("computeShardCount", () => {
  it("returns 1 for zero score", () => {
    expect(computeShardCount(0, DEFAULT_SHARD_TARGET_SIZE, 10)).toBe(1);
  });

  it("returns 1 for zero shardTargetSize (guard)", () => {
    expect(computeShardCount(1000, 0, 10)).toBe(1);
  });

  it("computes ceil(score / target)", () => {
    expect(computeShardCount(1000, 500, 10)).toBe(2);
    expect(computeShardCount(1001, 500, 10)).toBe(3);
    expect(computeShardCount(500, 500, 10)).toBe(1);
  });

  it("clamps to maxAgents", () => {
    expect(computeShardCount(10_000, 100, 5)).toBe(5);
  });

  it("respects the minimum of 1", () => {
    expect(computeShardCount(1, DEFAULT_SHARD_TARGET_SIZE, 10)).toBe(1);
  });

  it("uses DEFAULT_SHARD_TARGET_SIZE when target is not provided", () => {
    const score = DEFAULT_SHARD_TARGET_SIZE * 3;
    expect(computeShardCount(score, undefined, 10)).toBe(3);
  });
});
