/**
 * gh-exec.ts — the RAW `gh` runner for TRACK-1's remote spec-PR + issue write-back.
 *
 * WHY A SECOND gh SEAM
 *   `github-status.ts` `runGhJson` is the JSON-READ seam (parses stdout, degrades
 *   to `null`). TRACK-1 also has to make WRITES — create a git ref, PUT a file,
 *   `gh pr create`, `gh issue comment` — where we must:
 *     - distinguish an ALREADY-EXISTS outcome (branch/file already there, PR
 *       already open) from a real failure, which needs the raw stderr, and
 *     - read NON-JSON stdout (`gh pr create` prints a bare PR URL).
 *   `runGhCapture` fills that gap: it returns a discriminated union carrying stdout
 *   on success and the (path-scrubbed) stderr on failure, so the caller can branch
 *   on "already exists" vs "hard error". JSON reads STILL go through the shared
 *   `runGhJson` — this module never re-implements JSON parsing.
 *
 * SECURITY (mirrors pr-wrapper.ts / github-status.ts discipline)
 *   - Sanitized env: every inherited `GH_*` is stripped, then only the intended
 *     token var (`GH_TOKEN`/`GITHUB_TOKEN`) is re-added, so a poisoned ambient env
 *     (e.g. `GH_HOST`) cannot redirect `gh` to an attacker host and exfiltrate the
 *     token. Per-module DUPLICATION of `sanitizedEnv`/`KEEP_TOKEN_VARS` is the
 *     established house pattern (pr-wrapper + github-status each keep their own copy)
 *     — we duplicate it here rather than export/modify theirs.
 *   - Arg-array execFile only (never a shell string): nothing is interpolated into
 *     a shell, so an untrusted value can never inject a command. The CALLER is
 *     responsible for rejecting leading-dash VALUES (flag injection) — see
 *     spec-writer.ts / issue-writeback.ts.
 *   - The token is NEVER read or logged here; on any failure the surfaced error has
 *     its filesystem paths scrubbed (copy of pr-wrapper's `scrub`) before it leaves.
 *   - NEVER throws: a thrown `gh` (missing binary, non-zero exit, timeout) is
 *     converted to `{ ok: false, stderr }`.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { ExecFileFn } from "../../github-status.js";

/** Re-export the single `gh`-runner surface so the tracker modules import it from here. */
export type { ExecFileFn } from "../../github-status.js";

const execFileAsync: ExecFileFn = promisify(execFile);

/** The single token var this server intends to expose to `gh` (parity w/ pr-wrapper). */
const KEEP_TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/** Default per-call wall-clock budget for a `gh` write. */
const GH_CAPTURE_TIMEOUT_MS = 30_000;

/**
 * Sanitized env (pr-wrapper H-7b parity): drop every inherited `GH_*`, then re-add
 * only the intended token var(s). A poisoned ambient env can no longer redirect `gh`
 * to an attacker host and leak the token. PER-MODULE duplication is the house
 * pattern — do NOT export/modify pr-wrapper's or github-status's copies.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GH_")) continue; // drop ALL inherited GH_* first.
    env[k] = v;
  }
  for (const tokenVar of KEEP_TOKEN_VARS) {
    if (process.env[tokenVar]) env[tokenVar] = process.env[tokenVar];
  }
  return env;
}

/** Scrub fs layout from an error string before returning it (copy of pr-wrapper's). */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Run `gh <args>` under the sanitized env, capturing stdout on success and the
 * path-scrubbed stderr/message on failure. NEVER throws. Used for `gh` calls whose
 * outcome we must inspect (already-exists vs hard-error) or whose stdout is NOT
 * JSON (`gh pr create` prints a bare URL; `gh issue comment`). JSON reads use
 * `runGhJson` (github-status.ts) instead.
 *
 * The CALLER must supply only fixed, shape-validated args (nothing leading-dash /
 * attacker-shaped can be read as a flag) — this runner adds no arg validation.
 */
export async function runGhCapture(
  args: string[],
  run: ExecFileFn = execFileAsync,
  timeoutMs: number = GH_CAPTURE_TIMEOUT_MS,
): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  try {
    const { stdout } = await run("gh", args, { timeout: timeoutMs, env: sanitizedEnv() });
    return { ok: true, stdout: stdout ?? "" };
  } catch (err) {
    // promisify(execFile) rejects with an Error carrying `.stderr` (the process's
    // stderr) on a non-zero exit; a missing binary / timeout carries only `.message`.
    const e = err as { stderr?: unknown; message?: unknown };
    const raw =
      (typeof e?.stderr === "string" && e.stderr.length > 0 && e.stderr) ||
      (typeof e?.message === "string" && e.message) ||
      String(err);
    return { ok: false, stderr: scrub(raw) };
  }
}
