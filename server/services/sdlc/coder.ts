/**
 * coder.ts — SDLC executor, component 2: the agentic coder.
 *
 * Runs the LOCAL `claude` CLI in AGENTIC mode INSIDE an isolated worktree to make
 * real, multi-file code/spec edits implementing the round's open action points.
 * Unlike the legacy single-shot pipeline stages, this is a full coding agent with
 * file-write tools — so confinement is the whole game.
 *
 * Invocation (the exact arg array; prompt via STDIN — never argv/shell):
 *   claude -p --output-format json --permission-mode acceptEdits \
 *          --allowedTools Edit Write Read --add-dir <worktreeDir>
 *   cwd = <worktreeDir> ; stdin = <prompt> ; hard timeout (default 600s)
 *
 * Spawn discipline is reused from `cli-spawn.ts` (the same module the
 * subscription `claude-cli` provider uses): arg-array spawn (no shell), per-proc
 * timeout with SIGTERM→SIGKILL escalation, ENOENT→typed CliNotInstalledError,
 * bounded concurrency. Output is parsed via the provider's `parseCompleteOutput`
 * (`--output-format json` → one JSON object).
 *
 * Stage 2a (skilled coder): the invocation is now PARAMETERISABLE by a SkilledStep
 * — a capability-scoped `--allowedTools` (only ever NARROWS the baseline) + a
 * prepended role `systemPrompt`. The DEFAULTS reproduce the legacy invocation
 * BYTE-FOR-BYTE, so the unskilled path is unchanged. No new execution: the coder
 * still only edits files; build/test stays SERVER-SIDE (Stage 2b).
 *
 * SECURITY (BINDING — adversarial-review surface):
 *   - The action-point text is UNTRUSTED model output. It reaches ONLY the prompt,
 *     and ONLY via STDIN (a safe channel) — never an argv element, never a shell
 *     string. Every field is clamped before it enters the prompt.
 *   - File-tool access is confined to the worktree via `cwd` + `--add-dir
 *     <worktreeDir>` (Edit/Write/Read cannot reach the user's checkout or `main`).
 *   - `--permission-mode acceptEdits` auto-approves EDITS only; we do NOT pass
 *     `--dangerously-skip-permissions`. `--allowedTools` is an explicit, minimal
 *     allowlist of FILE tools only (Edit/Write/Read) — NO Bash (C-1: a Bash child
 *     is not confined by `--add-dir` and would escape the worktree), NO MCP, NO web.
 *     A Stage-2a capability can only SUBSET this (read-only ⇒ Read); the baseline is
 *     the hard ceiling `buildCoderArgs` enforces — it is NEVER loosened.
 *   - The coder spawns under a SANITIZED, ALLOWLISTED env (H-1): only PATH/HOME/
 *     locale + the claude CLI's own auth/config vars are forwarded. DB creds,
 *     GH_TOKEN/GITHUB_TOKEN, AWS_ vars, PASSWORD/SECRET/other TOKEN vars, and
 *     ANTHROPIC_API_KEY are NOT inherited — even with Bash gone, defense-in-depth.
 */
import { spawnCli, ConcurrencyLimiter, CliNotInstalledError } from "../../gateway/providers/cli-spawn.js";
import { parseCompleteOutput } from "../../gateway/providers/claude-cli.js";
import type { ActionPoint } from "@shared/types";

const DEFAULT_BINARY = "claude";
/**
 * Hard wall-clock cap on a single PER-ACTION-POINT coding run (bounded, never
 * unbounded). The executor runs the coder once per action point, so this bounds
 * ONE action point. Overridden per-call from `consiliumLoop.sdlcTimeoutMs`.
 */
const DEFAULT_TIMEOUT_MS = 1_200_000; // 20 min
const DEFAULT_MAX_CONCURRENCY = 2;
const SUMMARY_MAX = 4_000;
const ERROR_MAX = 300;

/**
 * The minimal, explicit tool allowlist handed to `--allowedTools`, passed as
 * SEPARATE argv elements (the CLI collects them variadically).
 *
 * SECURITY (C-1): Bash is DELIBERATELY EXCLUDED. A Bash subprocess is a child
 * process that is NOT path-confined by `--add-dir`/`cwd` — under headless `-p` +
 * `acceptEdits` it would be auto-approved and could `cd` out of the worktree,
 * read the repo `.env` symlink (live POSTGRES_PASSWORD) and write to the user's
 * checkout or `main`. File edits do not need Bash. If a build/test step is ever
 * required it MUST run SERVER-SIDE after the coder returns — never inside the agent.
 *
 * Stage 2a: this is ALSO the hard CEILING `buildCoderArgs` filters every requested
 * tool list against — a capability/skill can subset it but can NEVER add to it.
 */
export const ALLOWED_TOOLS = ["Edit", "Write", "Read"] as const;

/**
 * Safe shape for the OPTIONAL operator-pinned coder model slug (config
 * `pipeline.consiliumLoop.implement.coderModel`). A pinned model reaches the
 * `claude` CLI as a SEPARATE argv element (`--model <slug>`, arg-array, no shell),
 * so it can never be word-split into extra flags — but we STILL constrain it so a
 * config value can never carry whitespace or a shell metacharacter: it can ONLY
 * ever be a model id.
 *
 * The task specified `^[a-zA-Z0-9._-]+$`; we TIGHTEN it to the strict subset below
 * — the FIRST character must be alphanumeric, so a value can never even LOOK like a
 * flag (`-p`, `--dangerously-skip-permissions`) regardless of how the CLI's arg
 * parser treats a leading-dash option value. Every value this accepts the specified
 * regex also accepts (strict subset), so it stays within the required slug shape
 * while closing the leading-`-` flag-injection vector the adversarial review flags.
 * Enforced at BOTH the config schema (fail-closed at load) AND here at the argv seam
 * (defense-in-depth — an invalid value is dropped, degrading to the CLI default).
 */
export const CODER_MODEL_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** True iff `model` is a safe model slug (see {@link CODER_MODEL_SLUG_RE}). */
export function isValidCoderModel(model: string): boolean {
  return CODER_MODEL_SLUG_RE.test(model);
}

/**
 * H-1 — the coder spawns under a COMPLETE, ALLOWLISTED env (not the inherited
 * `process.env`). Only these keys are forwarded: PATH/HOME + locale so the OS can
 * resolve + run the `claude` binary, and the claude CLI's OWN auth/config vars so
 * the subscription session still authenticates. EVERYTHING else — DB creds,
 * GH_TOKEN/GITHUB_TOKEN, AWS_ vars, PASSWORD/SECRET/other TOKEN vars, and
 * ANTHROPIC_API_KEY (subscription mode does not need it) — are dropped. Pure
 * allowlist: a new secret env var is excluded by default (fail-closed).
 */
export const CODER_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TZ",
  // The claude CLI's own config/auth (subscription session). NOT api keys.
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/** Build the sanitized, allowlisted env handed to the coder's `claude` child. */
export function sanitizedCoderEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CODER_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/** Per-field clamps so untrusted action-point text stays bounded in the prompt. */
const TITLE_MAX = 300;
const RATIONALE_MAX = 2_000;
const FIELD_MAX = 80;
/** Clamp on a SKILLED step's prepended role prompt (Stage 2a) — bounded like every
 *  other prompt field. The prompt is code-trust (baked-in) or a user-authored skill
 *  row already in the platform, but it still goes to STDIN bounded. */
const SYSTEM_PROMPT_MAX = 4_000;

export interface CoderResult {
  /** True iff the CLI completed and did not report an error. */
  ok: boolean;
  /** The agent's final result text (clamped). */
  summary: string;
  /** Scrubbed error/preview on a non-ok run. */
  error?: string;
  /** input+output tokens the CLI reported (0 when unknown). */
  tokensUsed: number;
}

export interface CoderOptions {
  /** Binary name or absolute path. Defaults to "claude". */
  binary?: string;
  /** Hard timeout for this single per-action-point run (ms). Defaults to 1_200_000. */
  timeoutMs?: number;
  /** Cancels the session mid-flight. */
  signal?: AbortSignal;
  /** Override the spawned env (tests). Defaults to `sanitizedCoderEnv()` (H-1). */
  env?: NodeJS.ProcessEnv;
  /**
   * ADR-003 §3a.C dynamic scrubber: per-run leased secret VALUES to redact from
   * this coder's stderr (delivered via `env`, never in process.env). Absent ⇒
   * env-only scrubbing (byte-identical).
   */
  scrubValues?: readonly string[];
  /**
   * Stage 2a: the capability-scoped tool allowlist for THIS run (a SkilledStep's
   * `read-only` ⇒ ["Read"], `worktree-write` ⇒ the baseline). Defaults to the
   * baseline {@link ALLOWED_TOOLS}. Hard-filtered to the baseline ceiling in
   * `buildCoderArgs` — a capability can only ever NARROW, never widen.
   */
  allowedTools?: readonly string[];
  /**
   * Stage 2a: a SKILLED step's role prompt (code-trust baked-in default, optionally
   * layered with a user-authored skill row), PREPENDED to the coder prompt. Absent
   * ⇒ the legacy prompt verbatim (no regression).
   */
  systemPrompt?: string;
  /**
   * OPTIONAL operator-pinned model slug for the coder's `claude` CLI invocation
   * (config `pipeline.consiliumLoop.implement.coderModel`). When set AND a safe
   * slug, `buildCoderArgs` adds `--model <slug>`; absent (or invalid) ⇒ the CLI's
   * OWN default model — byte-for-byte today's invocation. Validated against
   * {@link CODER_MODEL_SLUG_RE} at the argv seam so config can never inject a flag.
   */
  model?: string;
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Render the round's action points into a single prompt. UNTRUSTED text — it goes
 * to STDIN only. Each field is clamped; the instruction is server-fixed and tells
 * the agent to make ONLY the file edits (the server owns commit/push/PR, so the
 * agent must NOT touch git/branches/PRs).
 *
 * Stage 2a: an OPTIONAL `systemPrompt` (a SKILLED step's role prompt — code-trust
 * baked-in default, optionally layered with a user-authored skill row) is PREPENDED
 * as a clamped block. When absent (the unskilled path) the result is BYTE-FOR-BYTE
 * identical to before — no regression.
 */
export function buildCoderPrompt(
  actionPoints: readonly ActionPoint[],
  opts: { systemPrompt?: string } = {},
): string {
  const items = actionPoints.map((ap, i) => {
    const title = clamp(ap.title ?? "", TITLE_MAX);
    const priority = clamp(ap.priority ?? "-", FIELD_MAX);
    const effort = clamp(ap.effort ?? "-", FIELD_MAX);
    const rationale = clamp(ap.rationale ?? "", RATIONALE_MAX);
    const tradeoff = clamp(ap.tradeoff ?? "", RATIONALE_MAX);
    const lines = [`${i + 1}. [${priority}] ${title}`];
    if (rationale) lines.push(`   Rationale: ${rationale}`);
    if (tradeoff) lines.push(`   Trade-off: ${tradeoff}`);
    if (effort && effort !== "-") lines.push(`   Effort: ${effort}`);
    return lines.join("\n");
  });
  // Stage 2a: prepend the skilled step's role prompt (clamped) when present. Empty
  // ⇒ no block ⇒ identical to the legacy prompt (the unskilled coder path).
  const sys = (opts.systemPrompt ?? "").trim();
  const preamble = sys ? [clamp(sys, SYSTEM_PROMPT_MAX), ""] : [];
  return [
    ...preamble,
    "You are an autonomous coding agent working in an ISOLATED git worktree of this repository.",
    "Implement the following review action points as REAL code/spec edits in THIS repository:",
    "",
    ...items,
    "",
    "Rules:",
    "- Make focused, correct edits that resolve each action point. Prefer the smallest change that fixes the issue.",
    "- Edit files ONLY inside this working directory.",
    "- Do NOT run `git commit`, `git push`, `git checkout`, or open any PR — the server handles version control after you finish.",
    "- Do NOT modify CI secrets, credentials, or unrelated files.",
    "- When done, briefly summarize what you changed.",
  ].join("\n");
}

/**
 * Build the exact agentic arg array (prompt is supplied separately via stdin).
 *
 * Stage 2a: `allowedTools` is the capability-scoped tool allowlist (defaults to the
 * baseline {@link ALLOWED_TOOLS} ⇒ identical to before). The requested tools are
 * HARD-FILTERED against the baseline ceiling, so a capability/skill can only ever
 * NARROW the surface — a value outside the baseline (e.g. `Bash`) is dropped, and a
 * wholly-empty result degrades to the baseline (fail-safe; never a widening). A
 * strict subset (read-only ⇒ ["Read"]) is honored exactly.
 *
 * `model` is the OPTIONAL operator-pinned coder model (config
 * `implement.coderModel`). When present AND a safe slug it is emitted as
 * `--model <slug>` (a SEPARATE argv element — no shell); absent OR invalid ⇒ NO
 * `--model` flag, so the CLI uses its own default and the arg array is BYTE-FOR-BYTE
 * the legacy invocation (no regression). The slug filter is the argv-seam half of
 * the two-layer guard (the config schema rejects a bad slug at load) — a config
 * value can NEVER inject an extra flag.
 */
export function buildCoderArgs(
  worktreeDir: string,
  allowedTools: readonly string[] = ALLOWED_TOOLS,
  model?: string,
): string[] {
  const ceiling = ALLOWED_TOOLS as readonly string[];
  const scoped = allowedTools.filter((t) => ceiling.includes(t));
  const tools = scoped.length > 0 ? scoped : [...ALLOWED_TOOLS];
  const modelArgs = model && isValidCoderModel(model) ? ["--model", model] : [];
  return [
    "-p",
    "--output-format",
    "json",
    ...modelArgs,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ...tools,
    "--add-dir",
    worktreeDir,
  ];
}

/** Scrub fs layout from an error string before returning it. */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, ERROR_MAX);
}

/**
 * The agentic coder. Bounded concurrency across calls (a module-level limiter).
 * Runs the CLI confined to `worktreeDir` and returns a typed result. Throws only
 * on an infrastructural failure (binary missing / spawn error / timeout); a CLI
 * that ran but reported an error returns `{ ok:false, error }`. The executor's
 * worktree cleanup runs in a `finally` regardless of which path this takes.
 */
export class SdlcCoder {
  private readonly binary: string;
  private readonly limiter: ConcurrencyLimiter;

  constructor(opts: { binary?: string; maxConcurrency?: number } = {}) {
    this.binary = opts.binary ?? DEFAULT_BINARY;
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  }

  async run(
    worktreeDir: string,
    actionPoints: readonly ActionPoint[],
    options: CoderOptions = {},
  ): Promise<CoderResult> {
    // Stage 2a: a SkilledStep MAY scope the tool surface (NARROW only) + prepend a
    // role prompt. Both default to the legacy values ⇒ the unskilled path is byte-
    // for-byte identical.
    const args = buildCoderArgs(worktreeDir, options.allowedTools, options.model);
    const prompt = buildCoderPrompt(actionPoints, { systemPrompt: options.systemPrompt });
    const { stdout } = await this.limiter.run(() =>
      spawnCli({
        binary: options.binary ?? this.binary,
        args,
        stdin: prompt, // UNTRUSTED text — stdin only, never argv/shell.
        cwd: worktreeDir, // confine the agent's working dir to the worktree.
        envOverride: options.env ?? sanitizedCoderEnv(), // H-1: no inherited secrets.
        scrubValues: options.scrubValues, // §3a.C: redact leased values from stderr.
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      }),
    );
    return parseCoderOutput(stdout);
  }
}

/**
 * Parse `--output-format json` stdout into a `CoderResult`. A CLI-reported error
 * (`is_error: true`) is surfaced as `{ ok:false }` rather than thrown, so the
 * executor can still commit whatever partial edits landed (or skip cleanly).
 */
export function parseCoderOutput(stdout: string): CoderResult {
  try {
    const parsed = parseCompleteOutput(stdout);
    return { ok: true, summary: clamp(parsed.content, SUMMARY_MAX), tokensUsed: parsed.tokensUsed };
  } catch (err) {
    if (err instanceof CliNotInstalledError) throw err;
    return { ok: false, summary: "", error: scrub(err instanceof Error ? err.message : String(err)), tokensUsed: 0 };
  }
}
