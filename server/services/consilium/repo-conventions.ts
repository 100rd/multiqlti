/**
 * repo-conventions.ts — reads a workspace repo's convention file (`AGENTS.md`, falling
 * back to `CLAUDE.md`) so the consilium loop's REVIEW and DEV (coder) stages can honor
 * repo-local conventions the same way a human contributor would.
 *
 * SCOPE: read-only, best-effort, kill-switched (config `consiliumLoop.repoConventions`,
 * default OFF ⇒ byte-identical). `AGENTS.md` is preferred; `CLAUDE.md` is the fallback —
 * the FIRST one that exists wins (never concatenated).
 *
 * BOUNDS / SAFETY (mirrors repo-map.ts / diff-context.ts):
 *   - Hard byte cap (`budgetBytes`): the file size is checked via `statSync` BEFORE
 *     `readFileSync` so the overflow decision never depends on re-measuring an already
 *     fully-buffered string; a file over budget is clamped (UTF-8-safe: `Buffer.subarray`
 *     then re-decode, same idiom as `diff-context.ts`'s repoMap/priorFindings clamps) and a
 *     one-line omission note is appended.
 *   - Secret redaction: the (possibly clamped) content is run through the SAME
 *     `redactSecrets` pass the diff uses (H-4 parity) before it is returned.
 *   - Fenced as DATA: the result is wrapped in `backtickFence` (a delimiter strictly longer
 *     than any backtick run inside the content) so the embedded file — raw, repo-authored
 *     text, unlike the derived repo-map — cannot break out of its own fence and smuggle
 *     instructions into the surrounding review/coder prompt.
 *   - Best-effort: neither file present, a stat/read error, or ANY other failure yields
 *     `null` (the caller omits the section/prompt block) — this NEVER throws.
 *
 * PATH SAFETY: `dirPath` is caller-resolved and ALREADY SAFE before this module ever sees
 * it — the review caller passes an `assertAllowedRepoPath`-resolved repo path, the dev
 * (SDLC) caller passes a server-minted worktree directory. The filename joined onto it is a
 * HARDCODED STRING LITERAL (`"AGENTS.md"` / `"CLAUDE.md"`), never derived from any input, so
 * `join(dirPath, "AGENTS.md")` carries no path-traversal risk.
 */
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { redactSecrets } from "./diff-redactor.js";
import { backtickFence } from "./review-factory.js";

/** Preference order — the FIRST file that exists wins; never concatenated. */
const CONVENTION_FILENAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Read the first present convention file (`AGENTS.md`, else `CLAUDE.md`) under `dirPath`,
 * clamp it to `budgetBytes`, redact secrets, and fence it as data. Returns `null` when
 * neither file exists or ANY error occurs (best-effort — never throws).
 */
export function readConventionsFile(dirPath: string, budgetBytes: number): string | null {
  try {
    for (const filename of CONVENTION_FILENAMES) {
      const filePath = join(dirPath, filename);
      let size: number;
      try {
        size = statSync(filePath).size;
      } catch {
        continue; // this candidate doesn't exist (or isn't stat-able) — try the next.
      }
      const raw = readFileSync(filePath, "utf8");
      const overflow = size > budgetBytes;
      const clamped = overflow
        ? Buffer.from(raw, "utf8").subarray(0, budgetBytes).toString("utf8")
        : raw;
      const note = overflow ? `\n\n_(${filename} truncated to the configured byte budget)_` : "";
      const redacted = redactSecrets(clamped.trim()) + note;
      const fence = backtickFence(redacted);
      return `${fence}\n${redacted}\n${fence}`;
    }
    return null; // neither AGENTS.md nor CLAUDE.md present.
  } catch {
    return null; // best-effort: any unexpected failure omits the section, never throws.
  }
}
