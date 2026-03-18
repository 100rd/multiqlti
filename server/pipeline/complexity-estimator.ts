/**
 * Complexity Estimator — Phase 6.12.1
 *
 * Analyses a stage input string and produces a complexity score used to
 * compute the optimal shard count for dynamic splitting.
 *
 * Score formula:
 *   score = inputTokens * TOKEN_WEIGHT
 *         + fileCount  * FILE_WEIGHT
 *         + testCount  * TEST_WEIGHT
 *
 * Shard count:
 *   shards = Math.ceil(score / shardTargetSize)   (clamped to [1, maxAgents])
 */

import type { ShardComplexity } from "@shared/types";

// ─── Weights ──────────────────────────────────────────────────────────────────

const TOKEN_WEIGHT = 1;
const FILE_WEIGHT = 50;
const TEST_WEIGHT = 30;

/** Default target complexity score per shard (≈ ~500 tokens of work). */
export const DEFAULT_SHARD_TARGET_SIZE = 500;

// ─── Token estimation ────────────────────────────────────────────────────────

/**
 * Approximate token count for a string using the standard ≈4 chars/token
 * heuristic.  This avoids a full tokeniser dependency in the hot path.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── File count detection ────────────────────────────────────────────────────

/** File-path patterns (relative or absolute, common extensions). */
const FILE_PATH_RE =
  /(?:^|\s)(?:\.{0,2}\/)?[\w\-./]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|cpp|c|h|json|yaml|yml|toml|md|sh|sql)\b/gim;

export function countFileReferences(text: string): number {
  const matches = text.match(FILE_PATH_RE);
  if (!matches) return 0;
  const unique = new Set(matches.map((m) => m.trim().toLowerCase()));
  return unique.size;
}

// ─── Test count detection ────────────────────────────────────────────────────

/**
 * Detects test suites / test-file patterns in text.
 * Counts: `describe(`, `it(`, `test(`, `def test_`, `func Test`, `@Test`
 * plus explicit `.test.ts` / `.spec.ts` filenames.
 */
const TEST_CASE_RE =
  /\b(?:describe|it|test)\s*\(|def\s+test_\w+|func\s+Test\w+|\@Test\b/g;

const TEST_FILE_RE = /[\w\-]+\.(?:test|spec)\.[a-z]+\b/gi;

export function countTestReferences(text: string): number {
  const caseMatches = text.match(TEST_CASE_RE) ?? [];
  const fileMatches = text.match(TEST_FILE_RE) ?? [];
  const uniqueFiles = new Set(fileMatches.map((m) => m.toLowerCase()));
  return caseMatches.length + uniqueFiles.size;
}

// ─── Main estimator ───────────────────────────────────────────────────────────

/**
 * Analyse `input` and return a `ShardComplexity` breakdown.
 */
export function estimateComplexity(input: string): ShardComplexity {
  const inputTokens = estimateTokenCount(input);
  const fileCount = countFileReferences(input);
  const testCount = countTestReferences(input);
  const score =
    inputTokens * TOKEN_WEIGHT +
    fileCount * FILE_WEIGHT +
    testCount * TEST_WEIGHT;

  return { inputTokens, fileCount, testCount, score };
}

/**
 * Compute the optimal shard count given a complexity score and target.
 *
 * @param score            Composite complexity score from `estimateComplexity`
 * @param shardTargetSize  Target score per shard (defaults to DEFAULT_SHARD_TARGET_SIZE)
 * @param maxAgents        Hard upper bound on shard count
 */
export function computeShardCount(
  score: number,
  shardTargetSize: number = DEFAULT_SHARD_TARGET_SIZE,
  maxAgents: number = 10,
): number {
  if (score <= 0 || shardTargetSize <= 0) return 1;
  const raw = Math.ceil(score / shardTargetSize);
  return Math.max(1, Math.min(raw, maxAgents));
}
