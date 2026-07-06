/**
 * command-parser.ts — TRACK-6 (task-tracker-triggers.md §8): the PURE, strict parser
 * for the three tracker COMMENT COMMANDS. No I/O; unit-tested in isolation like
 * `command-parser.test.ts` (mirrors github-event-map.ts / role-compose.ts).
 *
 * THE THREE COMMANDS
 *   /spec    — force intake of this ticket (crystallise a spec) even if UNLABELLED.
 *   /approve — approve the spec: mark the ticket's spec PR ready-for-review.
 *   /stop    — cancel the ticket's active loop.
 *
 * STRICT TOKEN MATCH (adversarial: command injection via substring / casing)
 *   A command is recognised ONLY when it is the FIRST whitespace-delimited token of
 *   SOME line of the comment, matched EXACTLY (case-sensitive) against `/spec` |
 *   `/approve` | `/stop`. Consequences:
 *     - `/specification`, `/approved`, `/stopped` → the first token is NOT one of the
 *       exact tokens ⇒ NO match (never a substring/prefix match).
 *     - `please /stop` / `do not /approve` → the leading token is `please` / `do` ⇒ NO
 *       match (a command must LEAD its line, so it cannot be smuggled mid-sentence).
 *     - `/APPROVE`, `/Spec` → case-mismatch ⇒ NO match (no casing-bypass surface).
 *     - `/approve looks good` → leading token exactly `/approve` ⇒ approve (trailing
 *       prose after the token is allowed; only the token itself is load-bearing).
 *   The comment BODY is NEVER interpreted beyond this token check — it never reaches a
 *   shell or a prompt (the /spec crystallise path re-reads + fences the ISSUE text, not
 *   the comment).
 *
 * FIRST-WINS: a comment with multiple command lines resolves to the FIRST matching
 * line (top-to-bottom) so the outcome is deterministic and a trailing decoy cannot
 * override the operator's leading intent.
 */

/** The recognised command tokens (exact, case-sensitive). */
export type TrackerCommand = "spec" | "approve" | "stop";

/** token → command (exact match table; the ONLY accepted spellings). */
const COMMAND_TOKENS: Readonly<Record<string, TrackerCommand>> = {
  "/spec": "spec",
  "/approve": "approve",
  "/stop": "stop",
};

/**
 * Parse the FIRST command a comment body carries, or `null` when it carries none.
 * Strict per the contract above: the command must be the exact leading token of a line.
 */
export function parseTrackerCommand(body: string | undefined): TrackerCommand | null {
  if (typeof body !== "string" || body.length === 0) return null;
  // Bound the scan — a pathological comment cannot cost unbounded work.
  const lines = body.slice(0, 20_000).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // The first whitespace-delimited token of the line, matched EXACTLY.
    const token = trimmed.split(/\s+/, 1)[0];
    const cmd = COMMAND_TOKENS[token];
    if (cmd) return cmd;
  }
  return null;
}
