/**
 * spec-parser.ts — parse a committed spec/ADR Markdown file into its YAML
 * frontmatter + body, and decide whether it is a *ready* unit of work.
 *
 * Contract: docs/design/spec-as-task.md §2 (schema) + §3 (watch trigger).
 * A spec is a Markdown file with YAML frontmatter:
 *
 *   ---
 *   title:   "..."
 *   status:  draft | ready | in-progress | done   # only `ready` fires a loop
 *   source:  { kind, ref?, url? }                  # provenance (required)
 *   repo?:   <target repo path/slug>
 *   role?:   <standing-role name>
 *   skills?: [ ... ]
 *   acceptanceCriteria:                            # the DoD → verification criteria
 *     - "<criterion>"
 *   ---
 *   <body>
 *
 * SECURITY / ROBUSTNESS (flagged for the adversarial reviewer):
 *   P1. This module NEVER throws on bad input. A malformed / missing frontmatter,
 *       an oversized file, a binary blob, or an unreadable path all degrade to a
 *       safe `{ kind: "not-a-spec", reason }` result — a poisoned file under the
 *       watched globs must never crash the watcher loop.
 *   P2. YAML is parsed with `js-yaml` default `load` (v4 — the default schema is
 *       safe: no `!!js/function`, no code execution). We additionally cap the
 *       file size read from disk and reject NUL-byte (binary) content BEFORE the
 *       YAML parse so a huge/binary file can never blow the parser up.
 *   P3. The spec body is human-authored (lower risk) but is STILL byte-bounded
 *       before it becomes the loop objective — the caller clamps via
 *       `buildSpecInstruction`, and the factory clamps again downstream.
 *   P4. Glob matching (`pathMatchesSpecGlobs`) is a dependency-free, anchored
 *       regex conversion — no reliance on a transitive glob lib, deterministic,
 *       and matches a repo-relative glob against any absolute path suffix.
 */
import { readFileSync, statSync } from "fs";

// ─── Bounds (P2, P3) ────────────────────────────────────────────────────────

/** Max on-disk size we will read as a candidate spec. Specs are small prose. */
export const SPEC_MAX_FILE_BYTES = 512 * 1024; // 512 KiB
/**
 * Byte budget for the WHOLE engineerInstruction (DoD + body). Deliberately UNDER
 * the factory's `OBJECTIVE_EXTRA_MAX_BYTES` (8 KiB) head-keeping clamp so the
 * instruction we build is never itself truncated downstream — the criteria (§3
 * contract) always survive (Security H1). 7 KiB leaves headroom for the factory's
 * skill-append budgeting on top.
 */
export const SPEC_INSTRUCTION_MAX_BYTES = 7 * 1024; // 7 KiB (< the factory's 8 KiB clamp)
/** Floor reserved for the spec body so a criteria-heavy spec never starves context. */
export const SPEC_BODY_MIN_BYTES = 1_000;
/** Max bytes of a single acceptance-criterion line (defensive clamp). */
export const SPEC_CRITERION_MAX_BYTES = 1_000;
/** Max number of acceptance criteria rendered into the DoD (defensive clamp). */
export const SPEC_MAX_CRITERIA = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

/** The `source` provenance object (spec-as-task §2). All fields best-effort. */
export interface SpecSource {
  kind: string;
  ref?: string;
  url?: string;
}

/** The parsed, type-coerced frontmatter. Every field is optional at parse time;
 *  the ready-gate enforces which are required to FIRE. */
export interface SpecFrontmatter {
  title?: string;
  status?: string;
  source?: SpecSource;
  repo?: string;
  role?: string;
  skills?: string[];
  acceptanceCriteria: string[];
}

/** Why a candidate file is NOT a fireable spec (logged, never thrown). */
export type SpecParseReason =
  | "no-frontmatter"
  | "malformed-yaml"
  | "not-object"
  | "empty"
  | "too-large"
  | "binary"
  | "unreadable";

export type SpecParseResult =
  | { kind: "spec"; frontmatter: SpecFrontmatter; body: string }
  | { kind: "not-a-spec"; reason: SpecParseReason };

/** The ready-gate decision (spec-as-task §3/§5). A spec fires ONLY when
 *  `status: ready` AND acceptanceCriteria is non-empty. */
export type ReadyGateReason =
  | "not-a-spec"
  | "draft"
  | "no-acceptance-criteria"
  | "status:in-progress"
  | "status:done"
  | "status:blocked"
  | "unknown-status";

export type ReadyGateResult =
  | { fire: true; frontmatter: SpecFrontmatter; body: string }
  | { fire: false; reason: ReadyGateReason };

// ─── Frontmatter parsing ───────────────────────────────────────────────────────

/**
 * Matches a leading YAML frontmatter block: `---\n<yaml>\n---\n<body>`.
 * Tolerant of CRLF. The body is everything after the closing fence.
 */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/** Coerce an unknown YAML value to a trimmed non-empty string, else undefined. */
function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Coerce an unknown YAML value to a string[] (drops non-string / empty items). */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = asString(item);
    if (s !== undefined) out.push(s);
  }
  return out;
}

/** Coerce the `source` field to a SpecSource (best-effort; kind is required). */
function asSource(v: unknown): SpecSource | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const rec = v as Record<string, unknown>;
  const kind = asString(rec.kind);
  if (kind === undefined) return undefined;
  const source: SpecSource = { kind };
  const ref = asString(rec.ref);
  const url = asString(rec.url);
  if (ref !== undefined) source.ref = ref;
  if (url !== undefined) source.url = url;
  return source;
}

/**
 * Parse spec CONTENT (already read from disk) into `{ frontmatter, body }` or a
 * safe not-a-spec result. Pure + synchronous; never throws (P1).
 *
 * `loadYaml` is injected so the module has ONE import site for js-yaml and tests
 * can exercise the malformed-YAML path deterministically.
 */
export function parseSpecContent(
  content: string,
  loadYaml: (s: string) => unknown,
): SpecParseResult {
  if (content.length === 0) return { kind: "not-a-spec", reason: "empty" };
  // Binary guard (P2): a NUL byte means this is not a text spec.
  if (content.indexOf("\u0000") !== -1) return { kind: "not-a-spec", reason: "binary" };

  const m = FRONTMATTER_RE.exec(content);
  if (m === null) return { kind: "not-a-spec", reason: "no-frontmatter" };

  const yamlText = m[1];
  const body = (m[2] ?? "").replace(/^\r?\n/, ""); // drop the single leading blank line

  let parsed: unknown;
  try {
    parsed = loadYaml(yamlText);
  } catch {
    // Malformed YAML ⇒ safe not-a-spec, NEVER a throw (P1).
    return { kind: "not-a-spec", reason: "malformed-yaml" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "not-a-spec", reason: "not-object" };
  }

  const rec = parsed as Record<string, unknown>;
  const frontmatter: SpecFrontmatter = {
    title: asString(rec.title),
    status: asString(rec.status)?.toLowerCase(),
    source: asSource(rec.source),
    repo: asString(rec.repo),
    role: asString(rec.role),
    skills: asStringArray(rec.skills),
    acceptanceCriteria: asStringArray(rec.acceptanceCriteria),
  };
  return { kind: "spec", frontmatter, body };
}

// ─── File reading (size + binary guarded) ──────────────────────────────────────

/**
 * Read a candidate spec file from disk and parse it. Guards size (P2) and any
 * fs error (deleted/unreadable) → safe not-a-spec (P1). `readFile`/`statSize`
 * are injected for testability; they default to the fs sync primitives.
 */
export function readSpecFile(
  filePath: string,
  loadYaml: (s: string) => unknown,
  io: {
    statSize?: (p: string) => number;
    readFile?: (p: string) => string;
  } = {},
): SpecParseResult {
  const statSize = io.statSize ?? ((p: string) => statSync(p).size);
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let size: number;
  try {
    size = statSize(filePath);
  } catch {
    return { kind: "not-a-spec", reason: "unreadable" };
  }
  if (size > SPEC_MAX_FILE_BYTES) return { kind: "not-a-spec", reason: "too-large" };

  let content: string;
  try {
    content = readFile(filePath);
  } catch {
    return { kind: "not-a-spec", reason: "unreadable" };
  }
  return parseSpecContent(content, loadYaml);
}

// ─── Ready-gate (spec-as-task §3/§5) ────────────────────────────────────────────

// SPEC-2 (spec-as-task.md §4): `blocked` is a recognized, INERT terminal status —
// a spec-fired loop that fails/escalates/caps/cancels is flipped `in-progress →
// blocked` (see spec-status-writer.specStatusForTerminalLoop) so it never RE-FIRES
// (only `ready` fires). A human moves `blocked → ready` after fixing to re-trigger.
const RECOGNIZED_STATUSES = new Set(["draft", "ready", "in-progress", "done", "blocked"]);

/**
 * Decide whether a parsed candidate FIRES a loop. Fires ONLY when
 * `status: ready` AND acceptanceCriteria is non-empty. Every other outcome is a
 * NO-OP with a specific, loggable reason (spec-as-task §5).
 */
export function evaluateReadyGate(parsed: SpecParseResult): ReadyGateResult {
  if (parsed.kind === "not-a-spec") return { fire: false, reason: "not-a-spec" };

  const { frontmatter, body } = parsed;
  const status = frontmatter.status;

  // A frontmatter block with no recognizable spec status is just a markdown doc
  // with some metadata — not a spec envelope.
  if (status === undefined || !RECOGNIZED_STATUSES.has(status)) {
    return { fire: false, reason: status === undefined ? "not-a-spec" : "unknown-status" };
  }

  if (status === "draft") return { fire: false, reason: "draft" };
  if (status === "in-progress") return { fire: false, reason: "status:in-progress" };
  if (status === "done") return { fire: false, reason: "status:done" };
  // SPEC-2: a `blocked` spec is inert — it stalled and needs a human to move it back
  // to `ready`. NEVER fires (that would re-launch the same failing loop unbounded).
  if (status === "blocked") return { fire: false, reason: "status:blocked" };

  // status === "ready": REQUIRES non-empty acceptanceCriteria (the DoD the loop
  // verifies against — no criteria ⇒ nothing to verify ⇒ not ready).
  if (frontmatter.acceptanceCriteria.length === 0) {
    return { fire: false, reason: "no-acceptance-criteria" };
  }
  return { fire: true, frontmatter, body };
}

// ─── Spec → engineerInstruction (the loop objective) ────────────────────────────

const TRUNCATION_MARKER = "\n… [truncated]";

/**
 * Truncate a string to a UTF-8 byte budget, appending a marker when clamped. The
 * marker is RESERVED WITHIN the budget so the returned string is never longer than
 * `maxBytes` (the caller's budget math stays exact — see buildSpecInstruction H1).
 */
function clampBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  const room = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  // Slice on a byte boundary, then drop a possibly-broken trailing multibyte char.
  const slice = buf.subarray(0, room).toString("utf8").replace(/\uFFFD+$/, "");
  return `${slice}${TRUNCATION_MARKER}`;
}

/** UTF-8 byte length of a string. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Render the acceptance-criteria block, PACKING whole criteria under a byte budget
 * (whole items dropped — never a criterion truncated mid-line — with a trailing
 * "N omitted" note). Always keeps at least the first criterion. Each line is
 * clamped to SPEC_CRITERION_MAX_BYTES and the count to SPEC_MAX_CRITERIA. This
 * bounds the DoD independently so a spec with hundreds of criteria cannot blow the
 * objective budget (L1) and drop the LATER criteria to a downstream clamp.
 */
function renderCriteria(acceptanceCriteria: string[], budgetBytes: number): string {
  const capped = acceptanceCriteria.slice(0, SPEC_MAX_CRITERIA);
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = 0; i < capped.length; i++) {
    const line = `- ${clampBytes(capped[i].trim(), SPEC_CRITERION_MAX_BYTES)}`;
    const cost = byteLen(line) + 1; // + newline
    if (lines.length > 0 && used + cost > budgetBytes) {
      dropped = capped.length - i;
      break;
    }
    lines.push(line);
    used += cost;
  }
  const omitted = dropped > 0 ? `\n- … (${dropped} more criteria omitted to fit budget)` : "";
  return lines.join("\n") + omitted;
}

/**
 * Build the loop's `engineerInstruction` from a ready spec. The acceptance-criteria
 * Definition-of-Done is emitted FIRST, then the human-authored spec body.
 *
 * WHY DoD-first (Security H1): the whole instruction rides the factory's
 * `untrustedExtraBlock`, which HARD-CLAMPS to a byte budget by KEEPING THE HEAD and
 * dropping the tail. A body-first layout would let a long spec body push the
 * criteria — the contract the loop verifies against (§3) — off the end and out of
 * the objective entirely. Emitting the DoD first (and budgeting the whole
 * instruction under SPEC_INSTRUCTION_MAX_BYTES < the factory's 8 KiB objective
 * clamp) guarantees the criteria ALWAYS reach the reviewers. The body then gets
 * whatever budget remains (a minimum is reserved so context is never fully starved).
 *
 * `role`, when present, is surfaced as a one-line context header (it is NOT a
 * skill id — see the dispatch note — so it never risks a skill-resolution throw).
 */
export function buildSpecInstruction(
  body: string,
  acceptanceCriteria: string[],
  role?: string,
): string {
  const header = role ? `Role: ${clampBytes(role, 200)}\n\n` : "";
  const open = "Definition of Done — every criterion must be satisfied and verified:\n```\n";
  const close = "\n```\n\n## Spec\n";
  const overhead = byteLen(header) + byteLen(open) + byteLen(close);

  // Reserve a floor for the body so a criteria-heavy spec never fully starves the
  // context, and cap the criteria block with the remainder of the budget.
  const criteriaBudget = Math.max(
    200,
    SPEC_INSTRUCTION_MAX_BYTES - overhead - SPEC_BODY_MIN_BYTES,
  );
  const criteria = renderCriteria(acceptanceCriteria, criteriaBudget);

  const fixed = `${header}${open}${criteria}${close}`;
  const bodyBudget = Math.max(0, SPEC_INSTRUCTION_MAX_BYTES - byteLen(fixed));
  const clampedBody = clampBytes(body.trim(), bodyBudget);

  return `${fixed}${clampedBody}`;
}

// ─── Glob matching (dependency-free, anchored) ─────────────────────────────────

/**
 * Convert a repo-relative glob (e.g. a `docs/specs` recursive `.md` glob) to a RegExp that
 * matches any ABSOLUTE path whose suffix satisfies the glob at a path boundary.
 * Supports `**` (any path segments, incl. zero), `*` (within a segment), `?`
 * (one non-separator char); every other char is matched literally. Anchored to a
 * `/` boundary so `docs/specs/x.md` matches `/repo/docs/specs/x.md` but a glob is
 * never matched mid-segment (e.g. `xdocs/specs`). Deterministic; no lib (P4).
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` (optionally followed by `/`) → zero or more full path segments.
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:[^/]*/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  // Match the glob as a suffix at a path boundary (start-of-string or a `/`).
  return new RegExp(`(?:^|/)${re}$`);
}

/** True when `absPath` matches ANY of the repo-relative globs. */
export function pathMatchesSpecGlobs(absPath: string, globs: readonly string[]): boolean {
  const normalized = absPath.replace(/\\/g, "/");
  for (const glob of globs) {
    if (globToRegExp(glob).test(normalized)) return true;
  }
  return false;
}
