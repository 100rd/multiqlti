/**
 * diff-context.ts — A2 of the consilium loop (design §6).
 *
 * Builds the "Overall objective" markdown string fed to every debater + the
 * judge (`iteration.input`, direct-llm-prompt.ts:39) for one review round:
 *   objective + `## Changes since last review` (git diff base..HEAD) +
 *   `## Test results` (an opaque, bounded summary the DEV pipeline produced) +
 *   (Enh1, round > 1) `## Prior findings to verify` — the caller-supplied,
 *   byte-bounded, INERT round-history block so debaters verify closure.
 *
 * Design constraints honoured here:
 *   - NEVER throws — returns `DiffContextResult | GitFail` (reuses the
 *     `git-wrapper.ts` never-throws `GitResult<T>` discriminator + GitErrorKind).
 *   - simple-git arg-ARRAY API only — no shell, no `child_process` string exec.
 *   - Round 1 (`baselineCommit === null`) ⇒ objective-only, no diff.
 *   - Output bounded to `maxDiffBytes`; sets `truncated`.
 *
 * SECURITY (design §13 — BINDING):
 *   B-1: `baselineCommit` MUST pass `^[0-9a-f]{7,64}$`, then be round-tripped
 *        through `revparse --verify --end-of-options <sha>^{commit}`; the
 *        RESOLVED sha is used downstream. HEAD is resolved the same way. Every
 *        `diff(...)` is pinned with `--end-of-options` before the range so a
 *        value like `--output=…`/`--ext-diff`/`--no-index` can never be parsed
 *        as a git option. (Bundled git ≥2.24 — verified 2.50.1.)
 *   H-1: `buildDiffContext` re-validates `repoPath` against the allowlist
 *        itself (never trusts the caller).
 *   H-2: baseline sha is validated here on READ, not just at write time.
 *   H-4: a best-effort redactor strips secrets from the diff BEFORE it enters
 *        the prompt; the diff body is never logged; GitFail messages are
 *        scrubbed of diff/paths before return.
 */
import simpleGit from "simple-git";
import type { GitErrorKind, GitFail } from "../../config-sync/git-wrapper.js";
import { assertAllowedRepoPath } from "./repo-allowlist.js";
import { redactSecrets } from "./diff-redactor.js";
import { validateReviewRef } from "./ref-validator.js";

/** Minimal git surface the builder needs — lets unit tests inject a fake. */
export interface GitDiffClient {
  revparse(args: string[]): Promise<string>;
  diff(args: string[]): Promise<string>;
}

export interface DiffContextRequest {
  /** Target repo; re-validated against `allowedRepoPaths` (never trusted). */
  repoPath: string;
  /** <last-reviewed> commit; null ⇒ first round (objective only, no diff). */
  baselineCommit: string | null;
  /**
   * BRANCH-targeted review: the ref (branch name / revision) to resolve as the
   * HEAD side of the review. Defaults to "HEAD" (working-tree HEAD) for full
   * back-compat when null/undefined. SECURITY: fed to `revparse` ONLY as an
   * arg-array element and pinned behind `--end-of-options`, so an option-looking
   * or leading-dash ref can never be parsed as a git flag; for `diff-pr-review`
   * the resolved tip becomes the HEAD side of `baseline..<ref>`. The caller
   * (review-factory) has already strict-validated it (see ref-validator.ts).
   */
  ref?: string | null;
  /** Standing design-idea / group.input header. */
  objective: string;
  /** Allowlist roots from config.consiliumLoop.allowedRepoPaths. */
  allowedRepoPaths: readonly string[];
  /** Hard byte cap on the unified diff (config.consiliumLoop.maxDiffBytes). */
  maxDiffBytes: number;
  /** Bounded summary of the last DEV run's tests (opaque to A2). */
  testSummary?: string;
  /**
   * Enh1: round-history block (model-authored prior-round findings) injected
   * for round > 1 so debaters VERIFY CLOSURE of earlier items against the diff
   * below instead of re-discovering them or circling. Appended as a dedicated
   * section AFTER the diff. Treated as INERT text (never executed, never
   * logged) and hard-capped to `maxDiffBytes`; the caller pre-truncates the
   * findings list oldest-first to stay within budget.
   */
  priorFindings?: string;
  /** Injected git client (tests pass a fake); defaults to simple-git(repoPath). */
  gitClient?: GitDiffClient;
}

export interface DiffContextResult {
  ok: true;
  /** Assembled markdown → iteration.input. */
  input: string;
  /** Resolved HEAD sha. */
  headCommit: string;
  /** Resolved baseline sha, or null on round 1. */
  baselineCommit: string | null;
  /** True when the unified diff was clipped at maxDiffBytes. */
  truncated: boolean;
}

const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Char cap on the caller-supplied `testSummary` before it enters the LLM input.
 * The DEV pipeline produces it opaquely, so it is untrusted/unbounded here — a
 * 10MB summary would otherwise flow straight into every debater + judge prompt.
 */
const MAX_TEST_SUMMARY_CHARS = 20_000;

/** Clip a string to `max` chars; reports whether it was truncated. */
function clampStr(value: string, max: number): { text: string; clipped: boolean } {
  return value.length > max ? { text: value.slice(0, max), clipped: true } : { text: value, clipped: false };
}

/** Scrub anything that could leak fs layout or diff body from an error string. */
function scrubMessage(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 200);
}

function fail(errorKind: GitErrorKind, rawMessage: string): GitFail {
  return { ok: false, errorKind, message: scrubMessage(rawMessage) };
}

/**
 * B-1/H-2: strict-hex gate + `revparse --verify --end-of-options <sha>^{commit}`.
 * Returns the RESOLVED sha (used downstream), or a scrubbed GitFail.
 */
async function resolveCommit(git: GitDiffClient, ref: string): Promise<string | GitFail> {
  if (!SHA_RE.test(ref)) {
    return fail("unknown", "baseline commit is not a 7-64 char hex sha");
  }
  try {
    const out = await git.revparse(["--verify", "--end-of-options", `${ref}^{commit}`]);
    const resolved = out.trim();
    if (!SHA_RE.test(resolved)) return fail("unknown", "resolved commit is not a valid sha");
    return resolved;
  } catch (err) {
    return fail("not-a-repo", err instanceof Error ? err.message : String(err));
  }
}

/**
 * B-1: resolve the review HEAD to a concrete sha (server-derived, still
 * pinned/validated). `ref` defaults to "HEAD" (working-tree HEAD); a
 * BRANCH-targeted review passes the loop's `reviewRef` so the resolved tip is the
 * chosen branch's, WITHOUT any checkout. `--end-of-options` precedes the ref so a
 * leading-dash/option-looking ref can never be parsed as a git flag.
 */
async function resolveHead(git: GitDiffClient, ref: string): Promise<string | GitFail> {
  try {
    const head = (await git.revparse(["--verify", "--end-of-options", `${ref}^{commit}`])).trim();
    if (!SHA_RE.test(head)) return fail("unknown", "resolved HEAD is not a valid sha");
    return head;
  } catch (err) {
    return fail("not-a-repo", err instanceof Error ? err.message : String(err));
  }
}

interface DiffParts {
  stat: string;
  body: string;
  truncated: boolean;
}

/**
 * B-1/H-4: --stat summary + bounded unified diff. Diff OPTIONS (e.g. --stat)
 * precede `--end-of-options`; the attacker-influenced resolved `base..head`
 * range is placed AFTER it, so the range can never be parsed as a git option
 * (the security guarantee). The body is redacted of secrets and clipped to
 * maxDiffBytes. Never logs the body.
 */
/**
 * MED-1: parse the `git diff --stat` SUMMARY line ("... N insertion(s)(+), M
 * deletion(s)(-)") into a changed-line count WITHOUT buffering the diff body.
 * `--stat` output is bounded (one row per file + a summary), so reading it is
 * always safe. Used as a cheap pre-gate so a pathologically large diff is never
 * buffered into a string before the byte clamp. Unparseable input ⇒ 0 (do not
 * block — the post-read byte clamp still applies).
 */
function statChangedLines(stat: string): number {
  const ins = /(\d+)\s+insertion/.exec(stat);
  const del = /(\d+)\s+deletion/.exec(stat);
  const i = ins ? Number.parseInt(ins[1], 10) : 0;
  const d = del ? Number.parseInt(del[1], 10) : 0;
  return (Number.isFinite(i) ? i : 0) + (Number.isFinite(d) ? d : 0);
}

async function collectDiff(
  git: GitDiffClient,
  baseline: string,
  head: string,
  maxDiffBytes: number,
): Promise<DiffParts | GitFail> {
  const range = `${baseline}..${head}`;
  try {
    // `--stat` first: its output is bounded regardless of diff size, so it is
    // safe to buffer and doubles as a magnitude pre-check (MED-1).
    const stat = await git.diff(["--stat", "--end-of-options", range]);
    // MED-1 (memory DoS): if the change spans a pathologically large number of
    // lines, DO NOT buffer the full body — emit stat-only with a truncation note
    // so a hostile commit can't OOM the process before the clamp below. The
    // budget is deliberately generous (≥ maxDiffBytes lines, floor 50k) so it
    // NEVER trips for a normal diff; behaviour is identical for those.
    //
    // Residual (documented): a single file whose change is one enormous line
    // counts as ~1 changed line here, so the byte clamp after the read is its
    // only bound. That residual is the SAME trust boundary as the spec-blob DoS
    // (MED-1, review-factory): the diff range is two SERVER-resolved commits
    // (strict-hex baseline + validated reviewRef) inside an allowlisted repo, so
    // the only way to reach it is a hostile committed blob — git ≥2.24 streams
    // `--stat`/`diff` and simple-git exposes no per-call byte cap on `diff`.
    const lineBudget = Math.max(50_000, maxDiffBytes);
    if (statChangedLines(stat) > lineBudget) {
      return { stat: redactSecrets(stat).trim(), body: "", truncated: true };
    }
    const rawBody = await git.diff(["--end-of-options", range]);
    const redacted = redactSecrets(rawBody);
    const truncated = Buffer.byteLength(redacted, "utf8") > maxDiffBytes;
    const body = truncated ? Buffer.from(redacted, "utf8").subarray(0, maxDiffBytes).toString("utf8") : redacted;
    return { stat: redactSecrets(stat).trim(), body: body.trim(), truncated };
  } catch (err) {
    return fail("unknown", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Compose the markdown string that becomes iteration.input (design §6).
 * Returns the input plus whether any section was truncated (diff OR testSummary)
 * so the caller can surface a single `truncated` flag. A blank objective is
 * replaced with a clearly-marked placeholder (only reachable when a diff carries
 * the content; the round-1 empty-objective case is rejected upstream).
 */
function assembleInput(
  objective: string,
  parts: DiffParts | null,
  testSummary: string | undefined,
  priorFindings: string | undefined,
  maxDiffBytes: number,
): { input: string; truncated: boolean } {
  const obj = objective.trim();
  const sections = [obj.length > 0 ? obj : "_No objective supplied; review the changes below._"];
  let truncated = parts?.truncated ?? false;
  if (parts) {
    const note = parts.truncated ? "\n\n_(diff truncated to the configured byte limit)_" : "";
    // MED-1: collectDiff returns an empty body WITH truncated=true when it refused
    // to buffer a pathologically large diff. Surface the (bounded) --stat summary
    // plus an explicit omission note rather than the misleading "No changes".
    const changes =
      parts.body.length > 0
        ? `${parts.stat}\n\n\`\`\`diff\n${parts.body}\n\`\`\`${note}`
        : parts.truncated
          ? `${parts.stat}\n\n_(diff omitted — too large to embed; see the stat above)_`
          : "_No changes since last review._";
    sections.push(`## Changes since last review\n\n${changes}`);
  }
  if (testSummary && testSummary.trim().length > 0) {
    const clamped = clampStr(testSummary.trim(), MAX_TEST_SUMMARY_CHARS);
    if (clamped.clipped) truncated = true;
    const note = clamped.clipped ? "\n\n_(test results truncated to the configured limit)_" : "";
    sections.push(`## Test results\n\n${clamped.text}${note}`);
  }
  // Enh1: prior-round findings to verify — appended AFTER the diff so the model
  // reads objective -> changes-since-last-review -> (tests) -> items to confirm
  // closed. The caller already bounded this oldest-first; we apply a DEFENSIVE
  // byte clamp here so a round-history block can never exceed the diff's byte
  // budget (it is inert, model-authored prior-verdict text). The block carries
  // its own `## Prior findings to verify` header.
  if (priorFindings && priorFindings.trim().length > 0) {
    const raw = priorFindings.trim();
    const overflow = Buffer.byteLength(raw, "utf8") > maxDiffBytes;
    if (overflow) truncated = true;
    const text = overflow
      ? Buffer.from(raw, "utf8").subarray(0, maxDiffBytes).toString("utf8")
      : raw;
    const note = overflow ? "\n\n_(prior findings truncated to the configured byte limit)_" : "";
    sections.push(`${text}${note}`);
  }
  return { input: sections.join("\n\n"), truncated };
}

/**
 * Build the consilium review input for one round. Never throws.
 *
 * Round 1 (`baselineCommit === null`) ⇒ objective-only (no diff), reproducing
 * the manual v1. Otherwise: validate repoPath (H-1), resolve baseline (B-1/H-2)
 * + HEAD, collect the bounded redacted diff (H-4), and assemble.
 *
 * Input bounds: the diff is byte-bounded (maxDiffBytes) and the caller-supplied
 * `testSummary` is char-bounded (MAX_TEST_SUMMARY_CHARS); either clip sets the
 * single `truncated` flag. A round-1 request with an effectively-empty objective
 * is a caller error (there is no diff to carry content) → returns a GitFail
 * rather than emitting a blank LLM input.
 */
export async function buildDiffContext(
  req: DiffContextRequest,
): Promise<DiffContextResult | GitFail> {
  // H-1: re-validate the persisted repoPath ourselves — never trust the caller.
  let resolvedRepo: string;
  try {
    resolvedRepo = assertAllowedRepoPath(req.repoPath, req.allowedRepoPaths);
  } catch (err) {
    return fail("not-a-repo", err instanceof Error ? err.message : String(err));
  }

  const git: GitDiffClient = req.gitClient ?? simpleGit(resolvedRepo);

  // LOW-1 (defense-in-depth): reviewRef is write-once and strict-validated at the
  // factory boundary, but on later rounds the controller reads it back from the DB
  // and threads it here. Re-validate it ourselves before it touches git — an
  // invalid stored ref fails the round CLEANLY (in-band GitFail → the loop's
  // existing error path) instead of being passed to git. The ref is scrubbed from
  // the message so attacker-influenced input is never echoed into logs.
  if (req.ref != null) {
    try {
      validateReviewRef(req.ref);
    } catch {
      return fail("unknown", "stored review ref failed re-validation");
    }
  }

  // BRANCH-targeted review: resolve the chosen ref's tip (loop.reviewRef) as the
  // HEAD side; null/undefined ⇒ working-tree "HEAD" (full back-compat).
  const head = await resolveHead(git, req.ref ?? "HEAD");
  if (typeof head !== "string") return head;

  if (req.baselineCommit === null) {
    // No diff to carry content this round — a blank objective is a caller error.
    if (req.objective.trim().length === 0) {
      return fail("unknown", "objective is empty and there is no diff (round 1); refusing to emit a blank review input");
    }
    const built = assembleInput(req.objective, null, req.testSummary, undefined, req.maxDiffBytes);
    return { ok: true, input: built.input, headCommit: head, baselineCommit: null, truncated: built.truncated };
  }

  const baseline = await resolveCommit(git, req.baselineCommit);
  if (typeof baseline !== "string") return baseline;

  const parts = await collectDiff(git, baseline, head, req.maxDiffBytes);
  if (!("stat" in parts)) return parts;

  const built = assembleInput(req.objective, parts, req.testSummary, req.priorFindings, req.maxDiffBytes);
  return {
    ok: true,
    input: built.input,
    headCommit: head,
    baselineCommit: baseline,
    truncated: built.truncated,
  };
}
