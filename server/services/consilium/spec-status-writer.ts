/**
 * spec-status-writer.ts — SPEC-2 (spec-as-task.md §4): commit the spec's
 * `status:` frontmatter lifecycle flip (draft→ready→in-progress→done, plus the
 * terminal `blocked`) back to the repo the spec lives in.
 *
 * WHY A REMOTE (gh api) COMMIT — never a local git checkout/commit
 *   The watcher runs in the operator's server process against a LIVE working tree
 *   they may be editing. Flipping the status LOCALLY (checkout/add/commit) would
 *   mutate that tree — a destructive side effect an unattended trigger must never
 *   inflict. So every status write goes through the SAME safe `gh` HTTP seam
 *   SPEC-1/TRACK-1 use (spec-writer.ts): read the file's current blob on the
 *   default branch, rewrite the one status line, PUT it back on the default
 *   branch. The operator's tree is never touched; branch-protection, if any, makes
 *   the PUT fail — which degrades to a logged best-effort no-op, never a crash.
 *
 * WHY FRONTMATTER (not a sidecar) — spec-as-task.md §8 open question
 *   The status lives IN the spec's frontmatter (not a sidecar / loop-state row) so
 *   it is HUMAN-VISIBLE in the diff and on GitHub: a reviewer sees `in-progress`
 *   the moment the loop starts and `done` when the code PR merges, with the commit
 *   history as the audit trail. The cost is a small churn commit per transition —
 *   accepted for visibility. The `status:` value is the single source of truth for
 *   "is this being worked / done" (§7: no silent drift).
 *
 * RACE / SAFETY (flagged for the adversarial reviewer)
 *   R1. TWO ticks racing to flip the same spec: the pure {@link rewriteSpecStatus}
 *       is CAS-GUARDED on `expectedFrom` — it only rewrites when the file STILL
 *       reads the expected prior status. The second writer reads the already-flipped
 *       value → `status-mismatch` → no-op. Belt-and-braces: the GitHub contents PUT
 *       carries the blob `sha` we read; a concurrent write changes the sha → 409 →
 *       typed `sha-conflict` no-op. Two independent guards, no lost update, no clobber.
 *   R2. The status commit FAILING must never crash the loop/dispatch: every path is
 *       never-throw (`{ ok:false, reason }`); the callers invoke it best-effort.
 *   R3. Never clobber a HUMAN edit: because the flip is CAS-guarded on `expectedFrom`,
 *       a spec a human moved elsewhere (e.g. back to `draft`) is left untouched.
 *   R4. Fenced path: the spec's repo-relative path is derived + validated to stay
 *       INSIDE the spec repo (no `..`, not absolute) before it reaches `gh`.
 */
import { relative, isAbsolute } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { runGhJson, type ExecFileFn } from "../github-status.js";
import { parseOwnerRepo } from "../github-poller.js";
import { runGhCapture } from "./trackers/gh-exec.js";

const execFileAsync: ExecFileFn = promisify(execFile);

/** The spec lifecycle values (spec-as-task.md §2 + SPEC-2's terminal `blocked`). */
export type SpecStatusValue = "draft" | "ready" | "in-progress" | "done" | "blocked";

// ─── Pure: terminal loop state → target spec status (SPEC-2 §4 policy) ──────────

/**
 * Map a spec-fired loop's TERMINAL state to the spec status it should be flipped to,
 * or `null` to LEAVE the status unchanged (spec-as-task.md §4):
 *
 *   - `converged`  → null. The loop reached a positive terminal (a review converged,
 *     or a develop run's PR was merge-approved). The spec STAYS `in-progress`: the
 *     CODE PR is the next gate, and the spec goes `done` ONLY when that PR merges
 *     (never auto-`done` from a loop verdict — see {@link specStatusForPrMerge}).
 *   - `failed` / `stopped_cap` / `escalated` / `cancelled` → `blocked`. The unit of
 *     work stalled and needs a human. We flip to `blocked` (NOT back to `ready`) on
 *     purpose: `ready` would RE-FIRE the watch trigger (transition-to-ready) →
 *     another loop → likely the same failure → an unbounded re-fire loop + budget
 *     burn. `blocked` is inert (the ready-gate never fires on it), so recovery is an
 *     explicit human edit `blocked→ready` after fixing — which re-fires exactly once.
 *
 * This is the recoverability guarantee: a spec whose loop DIES is never stuck
 * `in-progress` forever — the terminal hook moves it to `blocked` (human-visible,
 * re-triggerable), and if the write itself fails the dedup already released so a
 * human can re-drive.
 */
export function specStatusForTerminalLoop(
  state: string,
): { to: SpecStatusValue; reason: string } | null {
  switch (state) {
    case "converged":
      return null; // stays in-progress — the code PR is the next gate.
    case "failed":
      return { to: "blocked", reason: "loop failed" };
    case "stopped_cap":
      return { to: "blocked", reason: "loop hit round cap" };
    case "escalated":
      return { to: "blocked", reason: "loop escalated to human" };
    case "cancelled":
      return { to: "blocked", reason: "loop cancelled" };
    default:
      return null; // non-terminal / unknown → never touch the spec.
  }
}

/**
 * Map an observed GitHub PR status for a spec-fired loop's CODE PR to the spec
 * status flip, or `null` for no change (spec-as-task.md §4 GATE 2). ONLY a `MERGED`
 * code PR closes the spec (`in-progress → done`). `OPEN`/`DRAFT` (still in review),
 * `CLOSED` (abandoned — a human re-opens/re-specs), and `unknown` (GitHub degraded)
 * all leave the spec untouched — we NEVER auto-`done` without a real merge.
 */
export function specStatusForPrMerge(
  prStatus: string,
): { to: SpecStatusValue; reason: string } | null {
  return prStatus === "MERGED" ? { to: "done", reason: "code PR merged" } : null;
}

/**
 * The minimal shape of a loop the code-PR→done reconciler reads (a structural slice
 * of `ConsiliumLoopRow` — kept local so the writer never imports the heavy schema).
 */
export interface SpecLoopView {
  state: string;
  prRef: string | null;
  triggerProvenance?: { spec?: { specPath?: string } } | null;
}

/**
 * SPEC-2 GATE-2 (spec-as-task.md §4): the code-PR-merge → `done` RECONCILER (the
 * documented hook). Given a spec-fired loop and an OBSERVED GitHub PR status for its
 * code PR (`prRef`), flip the spec `in-progress → done` IFF the PR is `MERGED`.
 *
 * This is deliberately the ONLY path to `done` — a spec is closed by a MERGED CODE
 * PR, never auto-`done` from a loop verdict (§4: "only a merged code PR closes the
 * spec"). It acts only when:
 *   - the loop is SPEC-FIRED (`triggerProvenance.spec.specPath` present), AND
 *   - it carries a `prRef` (a real code PR was opened by a develop run), AND
 *   - the loop is at a PR-bearing terminal/awaiting state (`converged`/`awaiting_merge`), AND
 *   - the observed PR status is `MERGED`.
 * Everything else is a typed no-op. Never throws (delegates to the never-throw writer).
 * The `in-progress → done` write is CAS-guarded (a spec a human already closed/moved
 * is left untouched).
 *
 * WIRING (the hook): the existing PR-status seam (`github-status.ts`
 * `fetchPrStatus`/`githubStatusCache`, #474) already observes `MERGED` for a loop's
 * `prRef` in the `/api/pr-queue` reconcile. This function is what that observation
 * point calls to close the spec. See the SPEC-2 boundary note in the PR body:
 * periodic invocation INDEPENDENT of a queue view (a terminal `converged` loop is not
 * ticked by the poller) is the piece deferred to a follow-up.
 */
export async function reconcileSpecStatusOnPrMerge(
  deps: SpecStatusWriterDeps,
  loop: SpecLoopView,
  observedPrStatus: string,
  specRepoPath: string,
): Promise<WriteSpecStatusResult | { ok: false; reason: string }> {
  const specPath = loop.triggerProvenance?.spec?.specPath;
  if (!specPath) return { ok: false, reason: "not-spec-fired" };
  if (!loop.prRef) return { ok: false, reason: "no-pr-ref" };
  if (loop.state !== "converged" && loop.state !== "awaiting_merge") {
    return { ok: false, reason: "not-pr-bearing-state" };
  }
  const target = specStatusForPrMerge(observedPrStatus);
  if (!target) return { ok: false, reason: "pr-not-merged" };
  return writeSpecStatusRemote(deps, {
    specRepoPath,
    specPath,
    expectedFrom: "in-progress",
    to: target.to,
    reason: target.reason,
  });
}

// ─── Pure: repo-relative, fenced spec path (R4) ────────────────────────────────

/**
 * Derive the spec's repo-relative path for the `gh` contents API, fenced INSIDE the
 * spec repo. Returns `null` (caller no-ops) when the spec is not under the repo root
 * (escapes via `..`, is absolute after relativisation, or is empty) — a path that
 * could target a file outside the repo must never reach a write.
 */
export function specRelPath(repoRoot: string, specPath: string): string | null {
  if (repoRoot.length === 0 || specPath.length === 0) return null;
  const rel = relative(repoRoot, specPath).replace(/\\/g, "/");
  if (rel.length === 0) return null;
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

// ─── Pure: CAS-guarded status rewrite (R1/R3) ──────────────────────────────────

/** Matches the leading `---\n` fence so we can splice at an EXACT byte offset. */
const OPEN_FENCE_RE = /^\uFEFF?---[ \t]*\r?\n/;
/** Matches the whole frontmatter block; group 1 is the YAML text (mirror of spec-parser). */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n[\s\S]*)?$/;
/**
 * A single frontmatter `status:` line: prefix, optional quote, value (no quote /
 * comment / newline), same quote, optional trailing whitespace + `#` comment.
 */
const STATUS_LINE_RE =
  /^([ \t]*status[ \t]*:[ \t]*)(["']?)([^"'\r\n#]*?)\2([ \t]*(?:#[^\r\n]*)?)$/m;

export type SpecRewriteResult =
  | { changed: true; content: string; from: SpecStatusValue }
  | {
      changed: false;
      reason: "no-frontmatter" | "no-status-field" | "status-mismatch" | "unchanged";
      /** The current status found (for `status-mismatch`/`unchanged` logging). */
      current?: string;
    };

/**
 * Rewrite ONLY the frontmatter `status:` value, IFF it currently reads
 * `expectedFrom` (case-insensitive). Everything else — body, other frontmatter
 * keys, line endings, indentation, a trailing `# comment` on the status line — is
 * preserved byte-for-byte (the value is spliced at its exact offset, not re-emitted
 * via a YAML round-trip). Pure + never throws.
 *
 *   - no frontmatter fence            → `no-frontmatter`
 *   - frontmatter but no status line  → `no-status-field`
 *   - status is not `expectedFrom`    → `status-mismatch` (the R1/R3 guard: a racing
 *                                       writer or a human already moved it — no-op)
 *   - status is already `to`          → `unchanged` (idempotent re-run)
 */
export function rewriteSpecStatus(
  content: string,
  expectedFrom: SpecStatusValue,
  to: SpecStatusValue,
): SpecRewriteResult {
  const fm = FRONTMATTER_RE.exec(content);
  if (fm === null) return { changed: false, reason: "no-frontmatter" };
  const open = OPEN_FENCE_RE.exec(content);
  if (open === null) return { changed: false, reason: "no-frontmatter" };
  const yamlStart = open[0].length;
  const yaml = fm[1];

  const sm = STATUS_LINE_RE.exec(yaml);
  if (sm === null) return { changed: false, reason: "no-status-field" };

  const current = sm[3].trim().toLowerCase();
  if (current === to) return { changed: false, reason: "unchanged", current };
  if (current !== expectedFrom) return { changed: false, reason: "status-mismatch", current };

  // Rebuild the line unquoted (status values are simple slugs), preserving the
  // prefix (indent + `status:` + spacing) and any trailing `# comment`.
  const newLine = `${sm[1]}${to}${sm[4]}`;
  const absStart = yamlStart + sm.index;
  const absEnd = absStart + sm[0].length;
  const newContent = content.slice(0, absStart) + newLine + content.slice(absEnd);
  return { changed: true, content: newContent, from: expectedFrom };
}

// ─── Remote write (never throws) ───────────────────────────────────────────────

/** Default git-remote reader (spec-writer/github-poller parity; NEVER throws). */
export async function defaultGitRemoteUrl(
  repoPath: string,
  run: ExecFileFn = execFileAsync,
): Promise<string | null> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", repoPath, "remote", "get-url", "origin"],
      { timeout: 10_000 },
    );
    const url = (stdout ?? "").trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export interface SpecStatusWriterDeps {
  /** Injectable `gh` runner (tests pass a fake — no real `gh`/network). */
  runGh?: ExecFileFn;
  /** Read the spec repo's `origin` URL (→ owner/repo). Defaults to the git seam. */
  gitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  /** Structured logger. */
  log: (message: string) => void;
}

export interface WriteSpecStatusParams {
  /** The repo the SPEC FILE lives in (its OWN repo — may differ from the loop's target `repo:`). */
  specRepoPath: string;
  /** Absolute path of the spec file. */
  specPath: string;
  /** CAS guard: only flip when the file still reads this (R1/R3). */
  expectedFrom: SpecStatusValue;
  /** The new status. */
  to: SpecStatusValue;
  /** Short audit note folded into the commit message (e.g. the terminal reason). */
  reason?: string;
}

export type WriteSpecStatusResult =
  | { ok: true; from: SpecStatusValue; to: SpecStatusValue }
  | { ok: false; reason: string };

/** Decode a GitHub contents API base64 blob (newline-wrapped) to UTF-8 text. */
function decodeContentsBlob(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as { content?: unknown; encoding?: unknown; sha?: unknown };
  if (typeof rec.content !== "string") return null;
  if (rec.encoding !== undefined && rec.encoding !== "base64") return null;
  try {
    return Buffer.from(rec.content.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Commit the spec's `status:` flip REMOTELY on the default branch via `gh` (see the
 * module header). NEVER throws — every failure is a typed `{ ok:false, reason }` the
 * caller logs. The default-branch read-then-PUT is CAS-guarded twice (R1): the pure
 * rewrite only acts when the remote file still reads `expectedFrom`, and the PUT
 * carries the read blob `sha` so a concurrent write 409s instead of clobbering.
 */
export async function writeSpecStatusRemote(
  deps: SpecStatusWriterDeps,
  params: WriteSpecStatusParams,
): Promise<WriteSpecStatusResult> {
  const { runGh, log } = deps;
  const gitRemoteUrl = deps.gitRemoteUrl ?? ((p: string) => defaultGitRemoteUrl(p, runGh));
  const { specRepoPath, specPath, expectedFrom, to, reason } = params;

  try {
    // R4: repo-relative, fenced path.
    const relPath = specRelPath(specRepoPath, specPath);
    if (relPath === null) {
      log(`spec-status: refusing out-of-repo spec path ${specPath} (repo ${specRepoPath})`);
      return { ok: false, reason: "bad-path" };
    }

    // Origin-derived, validated owner/repo (reuse github-poller's parser).
    const remoteUrl = await gitRemoteUrl(specRepoPath);
    const ownerRepo = remoteUrl ? parseOwnerRepo(remoteUrl) : null;
    if (!ownerRepo) {
      log(`spec-status: no github owner/repo for ${specRepoPath} — skip`);
      return { ok: false, reason: "bad-origin" };
    }

    // Default branch (where a `ready` spec lives — §3/§4).
    const repoMeta = await runGhJson<{ defaultBranchRef?: { name?: string } }>(
      ["repo", "view", ownerRepo, "--json", "defaultBranchRef"],
      runGh,
    );
    const base = repoMeta?.defaultBranchRef?.name;
    if (!base || typeof base !== "string" || base.length === 0) {
      log(`spec-status: no default branch for ${ownerRepo} (gh degraded) — skip`);
      return { ok: false, reason: "no-default-branch" };
    }

    // Read the file's current blob (content + sha) on the default branch.
    const fileInfo = await runGhJson<{ content?: string; encoding?: string; sha?: string }>(
      ["api", `repos/${ownerRepo}/contents/${relPath}?ref=${base}`],
      runGh,
    );
    const sha = fileInfo?.sha;
    const decoded = decodeContentsBlob(fileInfo);
    if (!sha || typeof sha !== "string" || decoded === null) {
      log(`spec-status: could not read ${relPath}@${base} on ${ownerRepo} (gh degraded) — skip`);
      return { ok: false, reason: "read-failed" };
    }

    // R1/R3 CAS: only flip when the REMOTE file still reads `expectedFrom`.
    const rewrite = rewriteSpecStatus(decoded, expectedFrom, to);
    if (!rewrite.changed) {
      log(
        `spec-status: no-op ${expectedFrom}→${to} for ${relPath}@${base} — ${rewrite.reason}` +
          (rewrite.current ? ` (current=${rewrite.current})` : ""),
      );
      return { ok: false, reason: rewrite.reason };
    }

    // PUT the rewritten file on the default branch. The read `sha` makes a
    // concurrent write 409 (sha-conflict) rather than clobber (R1 second guard).
    const message = `chore(spec): status ${expectedFrom} -> ${to}${reason ? ` (${reason})` : ""}`;
    const base64 = Buffer.from(rewrite.content, "utf8").toString("base64");
    const putRes = await runGhCapture(
      [
        "api", "--method", "PUT", `repos/${ownerRepo}/contents/${relPath}`,
        "-f", `message=${message}`, "-f", `content=${base64}`, "-f", `sha=${sha}`, "-f", `branch=${base}`,
      ],
      runGh,
    );
    if (!putRes.ok) {
      // A 409 / sha mismatch means a concurrent write beat us — best-effort no-op.
      if (/409|sha.*(mismatch|does not match|wasn)|conflict/i.test(putRes.stderr)) {
        log(`spec-status: sha-conflict flipping ${relPath}@${base} (concurrent write) — no-op`);
        return { ok: false, reason: "sha-conflict" };
      }
      log(`spec-status: PUT failed for ${relPath}@${base} on ${ownerRepo}: ${putRes.stderr}`);
      return { ok: false, reason: "put-failed" };
    }
    log(`spec-status: flipped ${relPath}@${base} on ${ownerRepo}: ${expectedFrom} → ${to}`);
    return { ok: true, from: expectedFrom, to };
  } catch (err) {
    log(`spec-status: unexpected error: ${(err as Error).message}`);
    return { ok: false, reason: "exception" };
  }
}
