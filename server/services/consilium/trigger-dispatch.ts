/**
 * trigger-dispatch.ts — the file-change-trigger → consilium-review seam.
 *
 * `fireTrigger` (server/routes.ts) ALWAYS records `lastTriggeredAt` and then
 * delegates the optional `config.action` dispatch to `maybeLaunchConsiliumReview`
 * here. Pulling the decision out of the route closure gives it ONE injectable,
 * unit-testable surface (the factory is passed in as `createReview`, so a test
 * mocks it without spinning up Express / a DB / the consilium controller).
 *
 * Back-compat: an ABSENT `action` (every webhook / schedule / github / plain
 * file_change trigger) returns "noop" — the caller has already recorded
 * lastTriggeredAt, so nothing else happens.
 *
 * SECURITY (flagged for the adversarial reviewer):
 *   T1. The changed-file PATH (`payload.filePath`) and the `watchPath` are
 *       UNTRUSTED file-system input. They flow ONLY into `objectiveExtra`, which
 *       the factory control-strips + byte-clamps before it touches the objective
 *       body. Nothing here builds a shell string, branch, or PR title.
 *   T2. `repoPath` (action.repoPath OR the derived repo root) is NEVER trusted
 *       here — the factory RE-VALIDATES it against the fail-closed allowlist and
 *       throws on a miss. `deriveRepoRoot` is a convenience default only; a wrong
 *       guess fails closed (rejected) rather than widening access.
 *   T3. The launch runs under `runInProject(projectId)` (the route passes
 *       `runAsProject`) so every storage insert stays project-scoped. A trigger
 *       with a null projectId CANNOT launch a review (returns "skipped").
 *   T4. A factory throw (allowlist rejection, bad baseline, unknown preset) is
 *       caught and logged — a poisoned trigger config must never crash the
 *       watcher loop. The trigger has already fired + recorded.
 *   T5. (FIX HIGH-1 — DoS/cost amplification) ACTIVE-LOOP DEDUP on the trigger
 *       path. Each trigger fire builds a NEW task-group, so the DB's
 *       one-active-loop-PER-GROUP unique index can never dedup ACROSS fires — a
 *       burst of spec writes would otherwise spawn unbounded heavy-model
 *       disputes. Before launching, we read the project-scoped loop list and skip
 *       (return "skipped-dedup") if a NON-TERMINAL consilium loop already exists
 *       for the same (projectId, resolved repoPath). This guard is TRIGGER-PATH
 *       ONLY — the explicit UI endpoint (POST /api/consilium-reviews) is
 *       human-initiated and intentionally NOT deduped this way.
 *
 *       BOUND (T1, accepted): the dedup is a read-then-create check, not a
 *       transaction/lock, so two TRULY-CONCURRENT fires for the same
 *       (project, repoPath) that interleave between `getLoops()` and
 *       `createReview()` can both pass — creating AT MOST 2 active loops (each
 *       review-only, `maxRounds=1`), never a storm. It is not made race-safe by a
 *       partial unique index on non-terminal loops per (project, repoPath) BECAUSE
 *       that would ALSO block the human UI endpoint (intentionally un-deduped) from
 *       re-reviewing a repo with a review already in flight. The sequential burst
 *       vector (many spec writes to ONE watched repo, processed serially by the
 *       debounced watcher) IS caught. Making the concurrent case airtight —
 *       trigger-path-only advisory lock keyed on repoPath, or the §4 budget/debounce
 *       rails — is deferred to T1-full (loop-triggers.md §4.2–4.3).
 *   T6. (FIX MED-2 — autonomous coder from fs events) The trigger path FORCES
 *       maxRounds=1 (review-only) regardless of `action.maxRounds`, so an
 *       unattended file-system event can NEVER reach DEVELOPING / the SDLC coder.
 *       Anything above review-only must go through the human UI endpoint.
 *
 * ─── ACCEPTED single-tenant assumptions (documented, NOT fixed) ──────────────
 *   MED-3 (global allowlist trust boundary): `allowedRepoPaths` is a GLOBAL,
 *     single-tenant trust boundary. Project scoping confines which project the
 *     new loop ROWS belong to, but NOT which allowlisted repo a project may
 *     review — any project member can launch a review of ANY allowlisted repo.
 *     This is ACCEPTED for the current single-tenant deployment. For a
 *     multi-tenant deployment, intersect `allowedRepoPaths` with the project's
 *     own workspaces before the factory's allowlist check (per-project allowlist).
 *   LOW-1 (allowlist breadth): configure `allowedRepoPaths` as SPECIFIC repo
 *     roots, NEVER a broad parent directory. `deriveRepoRoot` walks UP to the
 *     narrowest enclosing `.git`, and the factory realpath-validates the result,
 *     so a tightly-scoped allowlist is the operative guard against breadth. A
 *     broad parent root would let a watched sub-tree review sibling repos. This
 *     is a CONFIG discipline, accepted as documented.
 */
import { existsSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { basename, dirname, join, resolve } from "path";
import { load as jsYamlLoad } from "js-yaml";
import {
  CONSILIUM_LOOP_TERMINAL_STATES,
  type TriggerRow,
  type ConsiliumLoopRow,
  type StandingRoleRow,
} from "@shared/schema";
import type {
  ConsiliumReviewTriggerAction,
  ConsiliumReviewPreset,
  GitHubEventTriggerConfig,
  GitLabEventTriggerConfig,
  TriggerProvenance,
  RoleProvenance,
  SpecProvenance,
  ReviewMode,
  RoleConcernBinding,
  StandingRoleConcern,
} from "@shared/types";
import { mapGitHubEventToReview } from "./github-event-map.js";
import { mapGitLabEventToReview } from "./gitlab-event-map.js";
import { composeRoleTriggerInstruction } from "./role-compose.js";
import {
  readSpecFile,
  evaluateReadyGate,
  buildSpecInstruction,
  pathMatchesSpecGlobs,
  applyAdrIntake,
} from "./spec-parser.js";
import type {
  CreateConsiliumReviewDeps,
  CreateConsiliumReviewParams,
} from "./review-factory.js";

/**
 * A trigger's loop-template config, narrowed to the two fields the dispatch reads.
 * Both file_change (has `watchPath`) and schedule (has neither, so `repoPath` on the
 * action is required) carry an optional `action`. Kept structural (not a specific
 * config type) so the seam stays type-agnostic across trigger classes.
 */
type LoopTemplateConfig = { watchPath?: string; action?: ConsiliumReviewTriggerAction } | null;

/** The literal token operators may embed in an engineerInstruction (§2). */
const EVENT_TOKEN = "${event}";

/**
 * A short, human description of the firing event, folded into the review objective
 * (via engineerInstruction ${event} interpolation OR objectiveExtra). UNTRUSTED
 * (it embeds fs paths / payload strings) → the factory control-strips + clamps +
 * fences it, so it is safe to compose here. Never a shell/branch/PR sink.
 */
export function describeEvent(trigger: TriggerRow, payload: unknown): string {
  const filePath = payloadString(payload, "filePath");
  if (filePath) return `file change at ${filePath}`;
  const scheduledAt = payloadString(payload, "scheduledAt");
  if (scheduledAt) return `scheduled run at ${scheduledAt}`;
  const event = payloadString(payload, "event");
  if (event) return `${trigger.type} event: ${event}`;
  return `${trigger.type} trigger fired`;
}

/**
 * A stable, short hex digest of the firing payload for provenance (§6). Enough to
 * correlate a loop to its event without persisting the (untrusted) payload verbatim.
 * A non-serialisable payload degrades to a digest of the string form.
 */
export function eventDigest(payload: unknown): string {
  let material: string;
  try {
    material = JSON.stringify(payload ?? null) ?? String(payload);
  } catch {
    material = String(payload);
  }
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Interpolate the `${event}` token in an operator instruction with the event
 * description. Returns undefined when there is no instruction (so the caller falls
 * back to objectiveExtra). Split/join replaces EVERY occurrence without invoking
 * regex-replacement's `$`-pattern semantics on the (untrusted) description.
 */
export function interpolateEvent(
  instruction: string | undefined,
  eventDescription: string,
): string | undefined {
  if (instruction === undefined || instruction.length === 0) return undefined;
  return instruction.split(EVENT_TOKEN).join(eventDescription);
}

/** A loop in one of these states never ticks again → does NOT block a new fire. */
const TERMINAL_LOOP_STATES: ReadonlySet<string> = new Set(CONSILIUM_LOOP_TERMINAL_STATES);

/**
 * Derive a best-effort repo ROOT from a trigger's watchPath when the
 * consilium_review action omits an explicit `repoPath`. Walks up to a bounded
 * depth looking for a `.git` entry (the conventional repo root); falls back to
 * the watchPath itself. ONLY a convenience default — the factory re-validates
 * the result against the allowlist (T2), so a wrong guess fails closed.
 */
export function deriveRepoRoot(watchPath: string | undefined): string | undefined {
  if (!watchPath || watchPath.length === 0) return undefined;
  let dir = watchPath;
  for (let i = 0; i < 24; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return watchPath;
}

/**
 * Best-effort canonicalisation so the dedup key (T5) matches the CANONICAL
 * `repoPath` the factory persists (`assertAllowedRepoPath` realpath's it). A
 * non-existent / unreadable path (e.g. a wrong guess) falls back to the raw
 * string — the factory will reject it on launch anyway, so dedup correctness is
 * not load-bearing for security, only for cost.
 */
function canonicalRepoPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Narrow an `unknown` fire payload to a string field without trusting its shape. */
export function payloadString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export type ConsiliumDispatchResult =
  | "launched"
  | "skipped"
  | "skipped-dedup"
  // ROLE-2 rails (loop-triggers.md §4): a role wake suppressed by the per-role daily
  // budget / concurrent-loop cascade ceiling. Both are counted as suppressed on the
  // trigger row (like dedup) and factory is NOT called.
  | "skipped-budget"
  | "skipped-cascade"
  | "noop"
  | "noop-event"
  | "failed";

/** ROLE-2: the per-role rails, defaulted from `role.policy` (role-wake path). */
export const DEFAULT_ROLE_BUDGET_PER_DAY = 20;
export const DEFAULT_ROLE_CASCADE_CEILING = 3;
/** The trailing window the per-role/day budget counts over. */
const ROLE_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The value `fireTrigger` (server/routes.ts) resolves with. It is the dispatch
 * result, PLUS `"recorded"` for the paths that record `lastTriggeredAt` but launch
 * nothing (the master-kill-switch-off early return). Existing callers (cron, file
 * watcher, webhook receiver) ignore it (their dep is typed `Promise<void>`, which
 * accepts any return); the github POLLER reads it to decide whether to advance its
 * watermark — it holds the watermark ONLY on `"skipped-dedup"` so a suppressed
 * event is retried next cycle rather than lost.
 */
export type TriggerFireResult = ConsiliumDispatchResult | "recorded";

export interface ConsiliumTriggerDispatchDeps {
  /**
   * The factory deps, or `null` when the consilium-loop subsystem (kill-switch)
   * is disabled. Null ⇒ a consilium_review action is skipped (logged), never an
   * error — the trigger still fired. When non-null, `reviewDeps.storage` is the
   * project-scoped store the dedup read (T5) goes through.
   */
  reviewDeps: CreateConsiliumReviewDeps | null;
  /** Injectable factory (defaults to `createConsiliumReview`); mocked in tests. */
  createReview: (
    deps: CreateConsiliumReviewDeps,
    params: CreateConsiliumReviewParams,
  ) => Promise<ConsiliumLoopRow>;
  /** Project-scoped ALS runner (the route passes `runAsProject`). T3. */
  runInProject: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Resolve a REAL `users.id` to own the launched review's `task_groups` row.
   * `task_groups.created_by` is an FK to `users.id`; the literal `"system"` is
   * NOT a user row, so a trigger-launched review (no `req.user`) must resolve a
   * concrete owner — the PROJECT OWNER (`projects.ownerId`, notNull). Returns
   * `null` when the project/owner cannot be resolved → the review is SKIPPED
   * (a review must have a valid owner). The route wires this under `runAsSystem`
   * so the lookup is not project-scoped away. T3.
   */
  resolveOwnerId: (projectId: string) => Promise<string | null>;
  /**
   * WRITE-on-fire (bug fix): record that a loop was ACTUALLY created for this
   * trigger — set `lastFiredAt` and atomically increment `firedCount`. Invoked ONCE,
   * ONLY on the successful-launch branch of `launchReviewWithDedup` (never on
   * dedup-suppress — that rides the caller's `incrementTriggerSuppressed`). Wired by
   * the route to the trigger store under the SAME (system) context as the suppressed
   * write. `firedAt` is the loop's provenance instant, threaded in for determinism.
   */
  recordFire: (triggerId: string, firedAt: Date) => Promise<void>;
  /**
   * SPEC-1 (spec-as-task.md §3): the spec-watch config accessor, or absent when the
   * caller does not wire it (every existing test / non-route caller). Returns the
   * ALREADY-master-gated view — the route folds `features.triggers.enabled` INTO
   * `enabled` so a single boolean decides whether the spec pre-check runs. When
   * absent OR `enabled === false`, `maybeLaunchConsiliumReview` skips the pre-check
   * entirely and is BYTE-IDENTICAL to the pre-SPEC-1 dispatch. `allowedRepoPaths`
   * is the consilium-loop repo allowlist (used to resolve a spec's `repo:` field).
   */
  specWatch?: () => SpecWatchDispatchView;
  /**
   * SPEC-2 (spec-as-task.md §4, GATE-1→work): flip the just-fired spec's frontmatter
   * `status: ready → in-progress` (a small remote commit to the spec file, via the
   * SAME safe `gh` seam SPEC-1/TRACK-1 use — never the operator's local tree). Called
   * BEST-EFFORT and ONLY on a real `launched` (not dedup-suppress / skip): a failed
   * status commit must NEVER flip the launch result or crash the watcher. This is the
   * DURABLE "this spec is being worked" signal that replaces reliance on the in-memory
   * active-loop dedup (which still guards the window before the commit lands). Absent
   * for every non-route caller / test ⇒ NO write (byte-identical). Gated by the route
   * behind `specWatch.enabled`, and only reached from inside the spec path (which only
   * runs when spec-watch is enabled) — so a disabled spec-watch never writes.
   */
  flipSpecStatus?: (args: {
    specPath: string;
    specRepoPath: string;
    from: "ready" | "in-progress" | "done" | "blocked" | "draft";
    to: "ready" | "in-progress" | "done" | "blocked" | "draft";
    reason?: string;
  }) => Promise<void>;
  /** Structured logger (the route passes `(m) => log(m, "triggers")`). */
  log: (message: string) => void;
}

/**
 * Launch a consilium review IFF the trigger carries a `consilium_review` action.
 * Returns a discriminant so the caller/tests can assert the branch taken without
 * inspecting logs:
 *   - "noop"          → no action (back-compat record-only path)
 *   - "skipped"       → action present but un-launchable (subsystem off / no
 *                       project / no repoPath / no resolvable project owner) —
 *                       logged, not an error
 *   - "skipped-dedup" → a non-terminal loop already runs for (project, repoPath)
 *                       on the TRIGGER path (T5) — logged, factory NOT called
 *   - "launched"      → factory invoked successfully
 *   - "failed"        → factory threw (e.g. allowlist rejection) — caught + logged
 */
export async function maybeLaunchConsiliumReview(
  deps: ConsiliumTriggerDispatchDeps,
  trigger: TriggerRow,
  payload: unknown,
): Promise<ConsiliumDispatchResult> {
  // ── SPEC-1 pre-check (spec-as-task.md §3) ──────────────────────────────────
  // A file_change whose changed file is under the spec globs (and spec-watch is
  // enabled — already master-gated by the route) is parsed as a committed spec and
  // routed to the spec path BEFORE the legacy action dispatch. This is the ONLY
  // added surface on the off path: when `specWatch` is absent or disabled, or the
  // changed file is not under the globs, control falls straight through and the
  // dispatch is BYTE-IDENTICAL to before. A file that matches the globs is handled
  // ENTIRELY by the spec path (fires or logs a reason) — it never also runs the
  // legacy action, so a spec write can never double-launch.
  const specCfg = deps.specWatch?.();
  if (specCfg?.enabled && trigger.type === "file_change") {
    const filePath = payloadString(payload, "filePath");
    if (filePath && pathMatchesSpecGlobs(filePath, specCfg.globs)) {
      return maybeLaunchSpecReview(deps, trigger, payload, filePath, specCfg.allowedRepoPaths);
    }
  }

  const config = trigger.config as LoopTemplateConfig;
  const action = config?.action;
  if (action?.kind !== "consilium_review") return "noop";

  if (!deps.reviewDeps) {
    deps.log(`consilium_review skipped for trigger ${trigger.id} — consilium loop disabled`);
    return "skipped";
  }
  // T3: a review MUST be project-scoped; a null-project trigger cannot launch one.
  const projectId = trigger.projectId;
  if (!projectId) {
    deps.log(`consilium_review skipped for trigger ${trigger.id} — trigger has no projectId`);
    return "skipped";
  }

  // T2: action.repoPath OR the watchPath-derived root — re-validated in the factory.
  const watchPath = payloadString(payload, "watchPath") ?? config?.watchPath;
  const repoPath = action.repoPath ?? deriveRepoRoot(watchPath);
  if (!repoPath) {
    deps.log(`consilium_review skipped for trigger ${trigger.id} — no repoPath/watchPath`);
    return "skipped";
  }

  // T1: the UNTRUSTED event description (embeds fs paths / payload strings) →
  // fed to the factory ONLY through its sanitized objective seam (control-strip +
  // byte-clamp + fence). Two mutually-exclusive sinks, in precedence order:
  //   1. If the operator wrote an engineerInstruction, INTERPOLATE `${event}` into
  //      it and pass it as `engineerInstruction` (persisted inert + feeds objective).
  //   2. Otherwise pass the bare description as `objectiveExtra` (legacy file_change
  //      behavior). The factory prefers engineerInstruction when BOTH are set, so we
  //      only ever populate one to keep the objective deterministic.
  const eventDescription = describeEvent(trigger, payload);
  const engineerInstruction = interpolateEvent(action.engineerInstruction, eventDescription);
  const objectiveExtra = engineerInstruction ? undefined : eventDescription;

  return launchReviewWithDedup(deps, trigger, {
    projectId,
    repoPath,
    preset: action.preset,
    engineerInstruction,
    objectiveExtra,
    payload,
  });
}

// ─── SPEC-1: spec-watch → consilium loop (spec-as-task.md §3) ──────────────────

/** The default preset for a spec fire when the trigger action does not pin one. */
const SPEC_DEFAULT_PRESET: ConsiliumReviewPreset = "sdlc-cross-review";

/** The spec-watch view the dispatch reads (the folded, master-gated config). */
export interface SpecWatchDispatchView {
  enabled: boolean;
  globs: string[];
  allowedRepoPaths: string[];
}

/**
 * Fold the spec-watch dispatch view from AppConfig. The master
 * `features.triggers.enabled` switch is AND-ed into `enabled` HERE, in ONE place, so
 * the dispatch sees a single boolean: master-off ⇒ effective-off ⇒ the spec
 * pre-check never runs and the file_change dispatch is BYTE-IDENTICAL to before.
 * (The parent `consiliumLoop.enabled` gate is enforced separately downstream via
 * `reviewDeps`, which is null when that subsystem is off.) The route wires this as
 * `specWatch: () => resolveSpecWatchConfig(appConfigLoader.get())`.
 */
export function resolveSpecWatchConfig(config: {
  features: { triggers: { enabled: boolean } };
  pipeline: {
    consiliumLoop: { allowedRepoPaths: string[]; specWatch: { enabled: boolean; globs: string[] } };
  };
}): SpecWatchDispatchView {
  const sw = config.pipeline.consiliumLoop.specWatch;
  return {
    enabled: config.features.triggers.enabled && sw.enabled,
    globs: sw.globs,
    allowedRepoPaths: config.pipeline.consiliumLoop.allowedRepoPaths,
  };
}

/**
 * Resolve a spec's `repo:` field to an ALLOWLISTED local path, fail-closed.
 *   - No `repo:` field ⇒ the trigger's OWN repo (`derivedRepo`, from the watchPath).
 *     May be undefined ⇒ the caller no-ops (no-repo).
 *   - An absolute `repo:` whose realpath is within/equals an allowed root ⇒ that
 *     canonical path.
 *   - A slug/basename `repo:` that matches the basename of exactly one allowed root
 *     ⇒ that allowed root.
 *   - Anything else (a `repo:` that maps to no allowed root) ⇒ `null` (no-op + log).
 *
 * The factory RE-VALIDATES the returned path against the same allowlist (+ the
 * project's workspaces), so this is a convenience resolver whose only failure mode
 * is to reject — it can NEVER widen access beyond the allowlist.
 */
export function resolveSpecRepo(
  repoField: string | undefined,
  derivedRepo: string | undefined,
  allowedRepoPaths: readonly string[],
): string | null {
  if (repoField === undefined || repoField.length === 0) {
    return derivedRepo ?? null;
  }
  const allowedCanon = allowedRepoPaths.map((p) => ({ raw: p, canon: resolve(canonicalRepoPath(p)) }));

  // Absolute path: accept iff its realpath is within/equal to an allowed root.
  if (repoField.startsWith("/")) {
    // M2 (defense-in-depth): realpathSync collapses `..` for an EXISTING path, but
    // a non-existent path falls back to the RAW string with `..` intact — which
    // could string-prefix-match an allowed root. `resolve` normalizes the traversal
    // LEXICALLY so `/allowed/root/../../etc` can never prefix-match `/allowed/root/`.
    const canonField = resolve(canonicalRepoPath(repoField));
    for (const a of allowedCanon) {
      if (canonField === a.canon || canonField.startsWith(a.canon + "/")) return canonField;
    }
    return null;
  }

  // Slug / basename: match the basename of exactly one allowed root.
  const matches = allowedCanon.filter((a) => basename(a.canon) === repoField);
  if (matches.length === 1) return matches[0].canon;
  return null;
}

/**
 * Parse a changed `docs/specs|adr` file as a committed spec and, IFF it is a
 * `ready` spec with acceptance criteria, launch ONE consilium loop for it
 * (spec-as-task.md §3). The caller has already confirmed the file is under the
 * spec globs and spec-watch is enabled (master-gated). Every non-firing outcome is
 * a logged NO-OP (never a throw): `draft` / `no-acceptance-criteria` / `not-a-spec`
 * / `status:done` / `no-repo`. The loop is:
 *   - `engineerInstruction` = the human-authored body + the acceptanceCriteria
 *     rendered as an explicit, fenced Definition-of-Done (byte-bounded).
 *   - `repoPath` = the spec's `repo:` resolved to an allowlisted path, else the
 *     trigger's own repo (unresolvable ⇒ no-op).
 *   - `skillIds` = the spec's explicit `skills` (the `role`, if any, is folded into
 *     the instruction header — NOT passed as a skill id, so it can never trigger a
 *     skill-resolution throw for a role that is not a registered skill).
 *   - dedup keyed by the SPEC PATH (one active loop per spec).
 *   - `triggerProvenance.spec = { specPath, source, status }`.
 *
 * Like every trigger path, the launch is FORCED review-only (maxRounds=1, T6) —
 * an unattended file-system event never reaches the SDLC coder; escalation to
 * develop is a human/UI action (SPEC-2+ boundary). Reuses the SAME
 * `launchReviewWithDedup` owner/factory/T4 core as every other trigger.
 */
export async function maybeLaunchSpecReview(
  deps: ConsiliumTriggerDispatchDeps,
  trigger: TriggerRow,
  payload: unknown,
  filePath: string,
  allowedRepoPaths: readonly string[],
): Promise<ConsiliumDispatchResult> {
  if (!deps.reviewDeps) {
    deps.log(`spec-watch skipped for ${filePath} — consilium loop disabled`);
    return "skipped";
  }
  const projectId = trigger.projectId;
  if (!projectId) {
    deps.log(`spec-watch skipped for ${filePath} — trigger has no projectId`);
    return "skipped";
  }

  // Parse + ready-gate. readSpecFile is size/binary/error-guarded and NEVER throws,
  // so a malformed/huge/binary/deleted file under the globs degrades to a no-op.
  // SPEC-4 (spec-as-task.md §2/§7): applyAdrIntake makes an ADR a valid task — for a
  // file under docs/adr/ (or with an `adr:`/`decision:` marker) it normalises the
  // accepted-state → ready and synthesises the implicit decision-DoD when the ADR
  // declares no explicit criteria, so the SAME ready-gate fires it. A non-ADR spec is
  // returned UNCHANGED (byte-identical SPEC-1/2). `isAdr` stamps the provenance.
  const rawParsed = readSpecFile(filePath, (s) => jsYamlLoad(s));
  const { parsed, isAdr } = applyAdrIntake(rawParsed, filePath);
  const gate = evaluateReadyGate(parsed);
  if (!gate.fire) {
    deps.log(`spec-watch no-op for ${filePath} — ${gate.reason}`);
    return "skipped";
  }
  const { frontmatter, body } = gate;

  // Resolve the target repo (spec `repo:` → allowlisted path, else the trigger's own).
  const config = trigger.config as LoopTemplateConfig;
  const watchPath = payloadString(payload, "watchPath") ?? config?.watchPath;
  const repoPath = resolveSpecRepo(frontmatter.repo, deriveRepoRoot(watchPath), allowedRepoPaths);
  if (repoPath === null) {
    deps.log(`spec-watch no-op for ${filePath} — no-repo (repo="${frontmatter.repo ?? ""}")`);
    return "skipped";
  }

  const engineerInstruction = buildSpecInstruction(
    body,
    frontmatter.acceptanceCriteria,
    frontmatter.role,
  );
  // ACCEPTED for SPEC-1 (M1): a skill id the factory cannot resolve project-scoped
  // THROWS → the launch is caught (T4) and returns "failed" (fail-closed, no
  // cross-tenant leak). SPEC-1 is HUMAN-AUTHORED specs only (no connectors — TRACK-1),
  // so the operator owns these ids and a typo failing visibly is acceptable; graceful
  // "drop unknown skill" is deferred to the connector-fed path (a synthesised spec).
  const skillIds =
    frontmatter.skills && frontmatter.skills.length > 0 ? frontmatter.skills : undefined;
  const preset = config?.action?.preset ?? SPEC_DEFAULT_PRESET;

  // The spec title is UNTRUSTED (frontmatter): single-line + clamp before it becomes
  // the inert provenance passport label (never a prompt/shell sink — display only).
  const titleLabel = (frontmatter.title ?? basename(filePath))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 120);

  const result = await launchReviewWithDedup(deps, trigger, {
    projectId,
    repoPath,
    preset,
    engineerInstruction,
    skillIds,
    // Per-spec dedup (NOT per-repo) — two specs in one repo each fire their own loop.
    specDedupKey: filePath,
    specProvenance: {
      specPath: filePath,
      status: frontmatter.status ?? "ready",
      ...(frontmatter.source ? { source: frontmatter.source } : {}),
      // SPEC-4: record that this loop was fired by an ADR (not a docs/specs spec).
      ...(isAdr ? { artifact: "adr" as const } : {}),
    },
    // H2: use the SANITIZED title (single-line, control-stripped, length-clamped) —
    // NOT the raw frontmatter title — for the inert provenance passport label.
    eventSummary: `spec ready: ${titleLabel}`,
    payload,
  });

  // SPEC-2 (§3/§4): a spec that ACTUALLY launched a loop transitions `ready →
  // in-progress` — the durable "being worked" marker that stops a re-fire once the
  // in-memory dedup expires (a `blocked`/`done`/`in-progress` spec no longer passes
  // the ready-gate). ONLY on a real `launched` (never dedup-suppress: that means a
  // loop is ALREADY running — its OWN launch already flipped the status, or is about
  // to; re-flipping would be a redundant no-op the CAS guard rejects anyway). The
  // spec file lives in ITS OWN repo (the watched repo), which may differ from the
  // loop's target `repo:` — so the write targets `deriveRepoRoot(watchPath)`, not
  // `repoPath`. Best-effort: the closure never throws; the extra catch is belt-and-
  // braces so a status-write hiccup can never turn a real launch into a crash.
  if (result === "launched" && deps.flipSpecStatus) {
    const specRepoPath = deriveRepoRoot(watchPath);
    if (specRepoPath) {
      await deps
        .flipSpecStatus({ specPath: filePath, specRepoPath, from: "ready", to: "in-progress" })
        .catch((e) => deps.log(`spec-status flip (launch) errored for ${filePath}: ${(e as Error).message}`));
    } else {
      deps.log(`spec-status flip (launch) skipped for ${filePath} — no spec repo root`);
    }
  }
  return result;
}

// ─── ADR-004 Block A: direct ticket intake (ticket → loop, no spec-PR) ─────────

/** The normalised ticket-task a tracker poller hands to the direct-intake launch. */
export interface TicketLaunchArgs {
  projectId: string;
  repoPath: string;
  /** Loop preset; absent ⇒ the spec default (`sdlc-cross-review`). */
  preset?: ConsiliumReviewPreset;
  /** Connector-normalised ticket identity (key already connector-sanitised). */
  ticket: { kind: string; key: string; title: string; url?: string };
  /** The extracted/synthesised task definition (criteria = condition of done). */
  spec: { problem?: string; scope?: string; outOfScope?: string; criteria: string[] };
}

/**
 * ADR-004 Block A: launch a review loop DIRECTLY from a tracker ticket — the ticket
 * IS the task; there is no committed-spec-PR intermediary. Reuses the SAME
 * `launchReviewWithDedup` core (owner FK, T4 catch, T6 review-only) with:
 *   - a per-ticket dedup anchor `ticket:<kind>:<key>` riding the spec-dedup seam
 *     (one active loop per ticket, not per repo);
 *   - provenance `spec.source = {kind, ref, url}` so write-back can join later;
 *   - the instruction built by the SAME `buildSpecInstruction` (DoD-first, clamped)
 *     the spec-watch path uses — the criteria always reach the reviewers.
 * The caller (poller) owns the consent gate, allowlist check, and watermark.
 */
export async function launchTicketReview(
  deps: ConsiliumTriggerDispatchDeps,
  trigger: TriggerRow,
  args: TicketLaunchArgs,
): Promise<ConsiliumDispatchResult> {
  if (!deps.reviewDeps) {
    deps.log(`ticket intake skipped for ${args.ticket.key} — consilium loop disabled`);
    return "skipped";
  }
  const bodyParts = [`## Problem\n${args.spec.problem ?? args.ticket.title}`];
  if (args.spec.scope) bodyParts.push(`## Scope\n${args.spec.scope}`);
  if (args.spec.outOfScope) bodyParts.push(`## Out of scope\n${args.spec.outOfScope}`);
  if (args.ticket.url) bodyParts.push(`Ticket: ${args.ticket.url}`);
  const engineerInstruction = buildSpecInstruction(bodyParts.join("\n\n"), args.spec.criteria);

  // UNTRUSTED title → single-line control-strip + clamp for the inert passport label.
  const titleLabel = args.ticket.title
    // eslint-disable-next-line no-control-regex
    .replace(/[ -]+/g, " ")
    .trim()
    .slice(0, 120);
  const anchor = `ticket:${args.ticket.kind}:${args.ticket.key}`;

  return launchReviewWithDedup(deps, trigger, {
    projectId: args.projectId,
    repoPath: args.repoPath,
    preset: args.preset ?? SPEC_DEFAULT_PRESET,
    engineerInstruction,
    // Per-ticket dedup: the synthetic anchor rides the spec-dedup seam, so two
    // tickets targeting one repo each fire their own loop (mirrors per-spec dedup).
    specDedupKey: anchor,
    specProvenance: {
      specPath: anchor,
      status: "ready",
      source: {
        kind: args.ticket.kind,
        ref: args.ticket.key,
        ...(args.ticket.url ? { url: args.ticket.url } : {}),
      },
    },
    eventSummary: `ticket picked: ${args.ticket.key}${titleLabel ? ` ${titleLabel}` : ""}`,
    payload: { ticket: args.ticket.key },
  });
}

/**
 * The launch plan the shared core turns into a factory call. `preset`/`repoPath`
 * are already chosen by the caller (the action's for file_change/schedule; the
 * event mapping's for github). `ref`/`baselineCommit` target a specific commit
 * (github PR head/base or push before/after); absent for the action path.
 * `engineerInstruction`/`objectiveExtra` are the (mutually-exclusive) UNTRUSTED
 * objective seams — the factory fences/clamps them. `eventSummary` is an OPTIONAL
 * human passport label. `payload` feeds the provenance digest ONLY.
 */
export interface ReviewLaunchPlan {
  projectId: string;
  repoPath: string;
  preset: ConsiliumReviewPreset;
  ref?: string | null;
  baselineCommit?: string;
  engineerInstruction?: string;
  objectiveExtra?: string;
  eventSummary?: string;
  /**
   * SPEC-1: operator/spec-selected skill ids, resolved PROJECT-SCOPED inside the
   * factory (a foreign id throws → "failed", caught by T4). Absent for every
   * non-spec path (byte-identical). The spec path passes `frontmatter.skills`.
   */
  skillIds?: string[];
  /**
   * SPEC-1 (spec-as-task.md §3): when set, the dedup key is the SPEC PATH — dedup
   * matches an active loop by `triggerProvenance.spec.specPath === specDedupKey`,
   * NOT by repoPath. This is what lets TWO distinct specs in the SAME repo each
   * fire their own loop (per-spec dedup, not per-repo). Absent ⇒ the historical
   * per-repoPath dedup (unchanged for every non-spec fire).
   */
  specDedupKey?: string;
  /** SPEC-1: spec origin folded into the loop's provenance (`{specPath,source,status}`). */
  specProvenance?: SpecProvenance;
  /**
   * ROLE-2: when a Standing Role wake launched this loop — folded into the loop's
   * provenance as `role: { roleId, name, concernId, cascadeDepth }`. Absent for every
   * legacy/spec/github fire (byte-identical). Its presence ALSO selects the role dedup
   * key (per-(role,concern), see `roleRails`) over the historical per-repoPath dedup.
   */
  roleProvenance?: RoleProvenance;
  /**
   * ROLE-2 (loop-triggers.md §4): the per-role rails evaluated in the dedup block —
   * one active loop per (role, concern) [dedup], a concurrent-loop ceiling [cascade],
   * and a trailing-24h launch cap [budget]. Present IFF `roleProvenance` is — a role
   * wake always carries both. Absent ⇒ the legacy repo/spec dedup is unchanged.
   */
  roleRails?: { roleId: string; concernId: string; budgetPerDay: number; cascadeCeiling: number };
  /**
   * ROLE-2: the role's `loopTemplate.reviewMode` (server enum), passed through to the
   * factory so a role wake's re-review rounds honour the role template. Undefined for
   * every non-role path (byte-identical — the factory resolves the operator default).
   */
  reviewMode?: ReviewMode;
  payload: unknown;
}

/**
 * The SHARED launch core: resolve the owner, dedup against in-flight loops for the
 * same (project, repoPath), and call the factory review-only. Extracted so BOTH
 * the action path (`maybeLaunchConsiliumReview`) and the github path
 * (`maybeLaunchGitHubReview`) reuse the SAME dedup (T5), owner FK resolution, and
 * T4 catch — the §4 rails cannot drift between trigger classes. Returns the same
 * discriminant. The caller has ALREADY verified `deps.reviewDeps` + `projectId`.
 */
export async function launchReviewWithDedup(
  deps: ConsiliumTriggerDispatchDeps,
  trigger: TriggerRow,
  plan: ReviewLaunchPlan,
): Promise<ConsiliumDispatchResult> {
  const reviewDeps = deps.reviewDeps;
  if (!reviewDeps) {
    deps.log(`review skipped for trigger ${trigger.id} — consilium loop disabled`);
    return "skipped";
  }

  // §6 provenance: which trigger + event fired the loop (short payload digest, not
  // the untrusted payload verbatim; + an OPTIONAL human summary). Persisted inert
  // for the launch passport.
  // The fire instant, computed ONCE at call-time (never Date.now() at import —
  // determinism rule). Used for BOTH the loop's provenance AND the trigger's
  // `lastFiredAt`, so the two always agree (the trigger row's lastFiredAt equals
  // the launched loop's provenance.firedAt).
  const firedAt = new Date();
  const provenance: TriggerProvenance = {
    triggerId: trigger.id,
    triggerType: trigger.type,
    eventDigest: eventDigest(plan.payload),
    firedAt: firedAt.toISOString(),
    ...(plan.eventSummary ? { eventSummary: plan.eventSummary } : {}),
    // SPEC-1 (§3): carry the spec origin so the per-spec dedup below and a future
    // write-back can find it. Inert jsonb; never a prompt/shell sink.
    ...(plan.specProvenance ? { spec: plan.specProvenance } : {}),
    // ROLE-2: a role wake also stamps WHICH role + concern woke the loop — the second
    // half of the (role, concern) dedup key and the launch-passport identity. Inert.
    ...(plan.roleProvenance ? { role: plan.roleProvenance } : {}),
  };

  // T5: dedup key — match against the CANONICAL path the factory persists.
  const resolvedRepo = canonicalRepoPath(plan.repoPath);
  // SPEC-1: a spec fire dedups on the SPEC PATH (one active loop per spec), NOT the
  // repo — so two distinct specs in the same repo each fire their own loop.
  const specDedupKey = plan.specDedupKey;

  // FK FIX: a trigger-launched review has no `req.user`. Resolve the PROJECT OWNER
  // (a real `users.id`). Inside the try so a lookup throw is caught (T4) rather
  // than crashing the watcher/webhook loop.
  let dedupLoopId: string | undefined;
  // ROLE-2: which per-role rail suppressed the launch (dedup | budget | cascade), set
  // inside the runInProject block so the post-block branch returns the right result.
  let roleSuppress: "dedup" | "budget" | "cascade" | undefined;
  try {
    const createdBy = await deps.resolveOwnerId(plan.projectId);
    if (!createdBy) {
      deps.log(
        `review skipped for trigger ${trigger.id} — no resolvable owner for project ${plan.projectId}`,
      );
      return "skipped";
    }

    const loop = await deps.runInProject(plan.projectId, async (): Promise<ConsiliumLoopRow | null> => {
      // T5 (FIX HIGH-1): active-loop DEDUP on the TRIGGER path. `getLoops()` is
      // project-scoped by this ALS context. Skip if a NON-TERMINAL consilium loop
      // already targets this repoPath — a burst of events (a PR synchronize storm,
      // a spec-write burst) must not fan out into unbounded heavy-model disputes.
      // (The explicit UI endpoint calls the factory directly and is NOT deduped.)
      const existing = await reviewDeps.storage.getLoops();

      // ROLE-2 (loop-triggers.md §4): the per-role rails REPLACE the repo/spec dedup
      // when this is a role wake — dedup on (role, concern), then a concurrent-loop
      // cascade ceiling, then a trailing-24h budget. Evaluated over the SAME
      // project-scoped loop list so a misfiring concern can never spawn unbounded loops.
      if (plan.roleRails) {
        const rail = evaluateRoleRails(existing, plan.roleRails, firedAt);
        if (rail.suppress) {
          roleSuppress = rail.suppress;
          dedupLoopId = rail.loopId;
          return null; // signal: a rail suppressed, do NOT launch the factory
        }
      } else {
        const active = existing.find((l) => {
          if (TERMINAL_LOOP_STATES.has(l.state)) return false;
          // SPEC-1: a spec fire dedups PURELY on the spec path (a distinct spec, even
          // in the same repo, is a DIFFERENT unit of work → its own loop). A non-spec
          // fire keeps the historical per-repoPath dedup.
          if (specDedupKey !== undefined) {
            return l.triggerProvenance?.spec?.specPath === specDedupKey;
          }
          return l.repoPath === resolvedRepo || l.repoPath === plan.repoPath;
        });
        if (active) {
          dedupLoopId = active.id;
          return null; // signal: deduped, do NOT launch the factory
        }
      }

      return deps.createReview(reviewDeps, {
        projectId: plan.projectId,
        repoPath: plan.repoPath,
        preset: plan.preset,
        // SPEC-1 / ROLE-2: spec- or role-selected skills (resolved project-scoped in
        // the factory); undefined for every non-spec/non-role path (byte-identical).
        skillIds: plan.skillIds,
        // FK FIX: real `users.id` (project owner), NOT the literal "system".
        createdBy,
        // T6 (FIX MED-2): FORCE review-only on EVERY trigger path — INCLUDING a role
        // wake. An unattended, automatically-fired run must NEVER reach DEVELOPING /
        // the SDLC coder; escalation to develop is a human (UI / manual-wake) action.
        maxRounds: 1,
        // ROLE-2: honour the role template's reviewMode (moot at maxRounds=1, but kept
        // faithful + forward-compatible); undefined elsewhere (factory resolves default).
        reviewMode: plan.reviewMode,
        // github diff-pr-review targets the PR head vs the PR base; absent for the
        // action path (working-tree HEAD). Both re-validated at the factory.
        ref: plan.ref,
        baselineCommit: plan.baselineCommit,
        // Exactly one of these is set (engineerInstruction wins in the factory).
        engineerInstruction: plan.engineerInstruction,
        objectiveExtra: plan.objectiveExtra,
        // §6: record which trigger + event (+ role) started the loop.
        triggerProvenance: provenance,
      });
    });

    if (loop === null) {
      // ROLE-2: a per-role rail suppressed the launch — return the specific result so
      // the caller can surface it (all three count as suppressed on the trigger row).
      if (roleSuppress === "budget") {
        deps.log(`role wake skipped-budget for trigger ${trigger.id} — role ${plan.roleRails?.roleId} over daily budget`);
        return "skipped-budget";
      }
      if (roleSuppress === "cascade") {
        deps.log(`role wake skipped-cascade for trigger ${trigger.id} — role ${plan.roleRails?.roleId} at concurrent-loop ceiling`);
        return "skipped-cascade";
      }
      deps.log(
        plan.roleRails
          ? `role wake skipped-dedup for trigger ${trigger.id} — active loop ${dedupLoopId} already running for (role ${plan.roleRails.roleId}, concern ${plan.roleRails.concernId})`
          : specDedupKey !== undefined
            ? `review skipped-dedup:spec for trigger ${trigger.id} — active loop ${dedupLoopId} already running for spec ${specDedupKey}`
            : `review skipped-dedup for trigger ${trigger.id} — active loop ${dedupLoopId} already running for ${resolvedRepo}`,
      );
      // WATERMARK DISCIPLINE: a dedup-suppressed fire must NOT touch lastFiredAt /
      // firedCount — the caller counts it via `incrementTriggerSuppressed` instead.
      return "skipped-dedup";
    }

    // BUG FIX (WRITE-on-fire): the loop was ACTUALLY created (not dedup-suppressed),
    // so record the fire on the trigger row — set `lastFiredAt = firedAt` and bump
    // `firedCount`. This is the success-branch counterpart to the caller's suppressed
    // increment; before this, a trigger that launched loops showed `lastFired: None`
    // and no fire tally (only suppressedCount advanced). It rides the launched branch
    // ONLY, so a race between concurrent webhook + poller fires cannot double-count:
    // the dedup already serializes loop CREATION, and exactly one fire reaches here.
    // Best-effort telemetry: a counter-write failure must NEVER flip a real launch to
    // "failed" nor crash the watcher/poller (T4) — the created loop is the source of truth.
    try {
      await deps.recordFire(trigger.id, firedAt);
    } catch (e) {
      deps.log(
        `review launched for trigger ${trigger.id} but fire-counter write failed: ${(e as Error).message}`,
      );
    }

    deps.log(
      `review launched for trigger ${trigger.id} (preset ${plan.preset}, loop ${loop.id})`,
    );
    return "launched";
  } catch (e) {
    // T4: never throw out of the watcher/webhook loop on a poisoned config.
    deps.log(`review for trigger ${trigger.id} rejected: ${(e as Error).message}`);
    return "failed";
  }
}

// ─── GitHub-event trigger → consilium review (T1-full, loop-triggers.md §3.1) ──
//
// The `payload` the github-event-handler hands to `fireTrigger` is the ENVELOPE
// `{ event, delivery, payload }` — the raw GitHub JSON body is under `.payload`.
// The HMAC signature has ALREADY been verified upstream (github-event-handler.ts /
// webhook-handler.ts) — this seam NEVER runs before a good signature. The
// event→(preset, ref, baseline, label) decision is the PURE `mapGitHubEventToReview`;
// the launch itself reuses the SAME dedup/owner/factory core as every other trigger.

/** Extract the raw GitHub JSON body from the `{ event, delivery, payload }` envelope. */
function githubBody(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as Record<string, unknown>).payload;
}

/**
 * Launch a consilium review for a matching GitHub webhook event.
 *   - "noop-event"  → the event is not mapped to a review (other PR action, push to
 *                     a non-default branch, issues/release/ping, …) — logged, NOT an
 *                     error, NOT a review (a webhook subscribed to everything is safe).
 *   - "skipped"     → subsystem off / no projectId / no repoPath in the loop template
 *                     / no resolvable owner — logged.
 *   - "skipped-dedup"→ a non-terminal loop already runs for this repo (T5 dedup).
 *   - "launched"    → the factory was invoked (diff-pr-review on the PR head, or a
 *                     post-merge review on the default branch).
 *   - "failed"      → the factory threw (allowlist/workspace rejection, bad ref) —
 *                     caught + logged (never crashes the receiver).
 *
 * The kill-switch (`features.triggers.enabled`) is enforced by the route BEFORE this
 * is called, mirroring the schedule gate — a running server never silently starts
 * firing github loops.
 */
export async function maybeLaunchGitHubReview(
  deps: ConsiliumTriggerDispatchDeps,
  trigger: TriggerRow,
  payload: unknown,
): Promise<ConsiliumDispatchResult> {
  const eventType = payloadString(payload, "event") ?? "";
  const body = githubBody(payload);

  // PURE mapping: decide the review shape (or a no-op reason) from the event.
  const mapped = mapGitHubEventToReview(eventType, body);
  if (mapped.kind === "noop") {
    deps.log(`github trigger ${trigger.id} — no-op for ${eventType || "?"}: ${mapped.reason}`);
    return "noop-event";
  }

  if (!deps.reviewDeps) {
    deps.log(`github trigger ${trigger.id} skipped — consilium loop disabled`);
    return "skipped";
  }

  const projectId = trigger.projectId;
  if (!projectId) {
    deps.log(`github trigger ${trigger.id} skipped — trigger has no projectId`);
    return "skipped";
  }

  // The loop template (embedded in the github config) supplies the TARGET repo. A
  // github trigger has no watchPath to derive it from, so repoPath is REQUIRED; the
  // factory re-validates it against the fail-closed allowlist + the project's
  // workspaces. The action.preset is IGNORED — the event mapping chooses the preset.
  const config = trigger.config as GitHubEventTriggerConfig;
  const action = config.action;
  const repoPath = action?.repoPath;
  if (!repoPath) {
    deps.log(`github trigger ${trigger.id} skipped — loop template has no repoPath`);
    return "skipped";
  }

  const { preset, ref, baselineCommit, eventLabel } = mapped.mapping;

  // T1/G1: the UNTRUSTED event label (PR #N: title) enters the objective ONLY via the
  // sanitized engineerInstruction/objectiveExtra seam (interpolate `${event}` into the
  // operator instruction when present, else pass the bare label). The factory
  // control-strips + byte-clamps + fences it — same discipline as the file_change path.
  const engineerInstruction = interpolateEvent(action?.engineerInstruction, eventLabel);
  const objectiveExtra = engineerInstruction ? undefined : eventLabel;

  return launchReviewWithDedup(deps, trigger, {
    projectId,
    repoPath,
    preset: preset as ConsiliumReviewPreset,
    ref,
    baselineCommit,
    engineerInstruction,
    objectiveExtra,
    // §6: a human passport label so #457 shows "fired by github trigger: PR #N".
    eventSummary: eventLabel,
    payload,
  });
}

// ─── GitLab-event trigger → consilium review (GitLab mirror of the GitHub seam) ─
//
// The `payload` the gitlab-event-handler hands to `fireTrigger` is the ENVELOPE
// `{ event, delivery, payload }` — the raw GitLab JSON body is under `.payload`.
// The shared-secret token has ALREADY been verified upstream (gitlab-event-handler.ts /
// webhook-handler.ts) — this seam NEVER runs before a good token. The
// event→(preset, ref, baseline, label) decision is the PURE `mapGitLabEventToReview`;
// the launch itself reuses the SAME dedup/owner/factory core as every other trigger.

/** Extract the raw GitLab JSON body from the `{ event, delivery, payload }` envelope. */
function gitlabBody(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as Record<string, unknown>).payload;
}

/**
 * Launch a consilium review for a matching GitLab webhook event.
 *   - "noop-event"  → the event is not mapped to a review (other MR action, push to
 *                     a non-default branch, Pipeline Hook, …) — logged, NOT an error,
 *                     NOT a review (a webhook subscribed to everything is safe).
 *   - "skipped"     → subsystem off / no projectId / no repoPath in the loop template
 *                     / no resolvable owner — logged.
 *   - "skipped-dedup"→ a non-terminal loop already runs for this repo (T5 dedup).
 *   - "launched"    → the factory was invoked (diff-pr-review on the MR head, or a
 *                     post-merge review on the default branch).
 *   - "failed"      → the factory threw (allowlist/workspace rejection, bad ref) —
 *                     caught + logged (never crashes the receiver).
 *
 * The kill-switch (`features.triggers.enabled`) is enforced by the route BEFORE this
 * is called, mirroring the schedule/github gate — a running server never silently
 * starts firing gitlab loops.
 */
export async function maybeLaunchGitLabReview(
  deps: ConsiliumTriggerDispatchDeps,
  trigger: TriggerRow,
  payload: unknown,
): Promise<ConsiliumDispatchResult> {
  const eventType = payloadString(payload, "event") ?? "";
  const body = gitlabBody(payload);

  // PURE mapping: decide the review shape (or a no-op reason) from the event.
  const mapped = mapGitLabEventToReview(eventType, body);
  if (mapped.kind === "noop") {
    deps.log(`gitlab trigger ${trigger.id} — no-op for ${eventType || "?"}: ${mapped.reason}`);
    return "noop-event";
  }

  if (!deps.reviewDeps) {
    deps.log(`gitlab trigger ${trigger.id} skipped — consilium loop disabled`);
    return "skipped";
  }

  const projectId = trigger.projectId;
  if (!projectId) {
    deps.log(`gitlab trigger ${trigger.id} skipped — trigger has no projectId`);
    return "skipped";
  }

  // The loop template (embedded in the gitlab config) supplies the TARGET repo. A
  // gitlab trigger has no watchPath to derive it from, so repoPath is REQUIRED; the
  // factory re-validates it against the fail-closed allowlist + the project's
  // workspaces. The action.preset is IGNORED — the event mapping chooses the preset.
  const config = trigger.config as GitLabEventTriggerConfig;
  const action = config.action;
  const repoPath = action?.repoPath;
  if (!repoPath) {
    deps.log(`gitlab trigger ${trigger.id} skipped — loop template has no repoPath`);
    return "skipped";
  }

  const { preset, ref, baselineCommit, eventLabel } = mapped.mapping;

  // G1: the UNTRUSTED event label (MR !N: title) enters the objective ONLY via the
  // sanitized engineerInstruction/objectiveExtra seam (interpolate `${event}` into the
  // operator instruction when present, else pass the bare label). The factory
  // control-strips + byte-clamps + fences it — same discipline as the file_change path.
  const engineerInstruction = interpolateEvent(action?.engineerInstruction, eventLabel);
  const objectiveExtra = engineerInstruction ? undefined : eventLabel;

  return launchReviewWithDedup(deps, trigger, {
    projectId,
    repoPath,
    preset: preset as ConsiliumReviewPreset,
    ref,
    baselineCommit,
    engineerInstruction,
    objectiveExtra,
    // §6: a human passport label so #457 shows "fired by gitlab trigger: MR !N".
    eventSummary: eventLabel,
    payload,
  });
}

// ─── ROLE-2: Standing Role wake (standing-role.md §3/§8, loop-triggers.md §4) ───
//
// A BACKING trigger whose `config.roleConcern = { roleId, concernId }` FIRES → instead
// of the legacy action, WAKE the role: compose the loop FROM THE ROLE (persona +
// concern.focus + the fired event, the role's skills + loop template) on the CONCERN's
// repoPath, and stamp `role` provenance. Reuses the SAME `launchReviewWithDedup` core
// (owner FK, factory, T4 catch, recordFire) and the SAME `createConsiliumReview` factory
// as every other path — NO reimplemented loop creation, and the controller is untouched.
//
// SECURITY (flagged for the adversarial reviewer):
//   R1. A role wake CANNOT bypass the allowlist — `concern.repoPath` is re-validated
//       fail-closed INSIDE the factory (never trusted from the stored concern), same
//       gate as the manual wake / UI review button. A bad repoPath → factory throw → T4
//       "failed", never a review of an unallowed repo.
//   R2. A DISABLED role never wakes (checked BEFORE the factory is touched — §6), and a
//       disabled concern is skipped. The role's `enabled` column is the authoritative gate.
//   R3. The per-role RAILS (evaluateRoleRails) bound a misfiring concern: one active loop
//       per (role, concern) [dedup], a concurrent-loop ceiling [cascade], a trailing-24h
//       cap [budget] — all read over the project-scoped loop list, so a burst of fires or
//       a role-loop that re-fires its own concern can never spawn unbounded loops.
//   R4. persona + concern.focus are UNTRUSTED at wake: composed here (join only) and
//       fenced/clamped by the factory (untrustedExtraBlock) before entering the objective.
//   R5. `skillIds = role.skills` is re-resolved PROJECT-SCOPED by the factory (a foreign
//       id throws → T4 "failed", no cross-tenant leak).
//   R6. maxRounds is FORCED to 1 (review-only, T6) — an unattended fire never reaches the
//       SDLC coder; escalation to develop is a human action (manual wake / UI).

/**
 * Evaluate the per-role rails over the (project-scoped) loop list. PURE + unit-testable.
 * Order: DEDUP (one active loop per (role, concern)) → CASCADE (concurrent active loops
 * across ALL the role's concerns ≥ ceiling) → BUDGET (loops launched by the role in the
 * trailing 24h ≥ budgetPerDay). Returns the first rail that suppresses (with the blocking
 * loop id for dedup), else `{}` (launch permitted).
 */
export function evaluateRoleRails(
  existing: readonly ConsiliumLoopRow[],
  rails: { roleId: string; concernId: string; budgetPerDay: number; cascadeCeiling: number },
  now: Date,
): { suppress?: "dedup" | "budget" | "cascade"; loopId?: string } {
  const roleLoops = existing.filter((l) => l.triggerProvenance?.role?.roleId === rails.roleId);

  // DEDUP: an active loop already running for this EXACT (role, concern).
  const dup = roleLoops.find(
    (l) => !TERMINAL_LOOP_STATES.has(l.state) && l.triggerProvenance?.role?.concernId === rails.concernId,
  );
  if (dup) return { suppress: "dedup", loopId: dup.id };

  // CASCADE: too many concurrent active loops for this role across ALL its concerns.
  const activeCount = roleLoops.filter((l) => !TERMINAL_LOOP_STATES.has(l.state)).length;
  if (activeCount >= rails.cascadeCeiling) return { suppress: "cascade" };

  // BUDGET: too many launched by this role in the trailing 24h (LLM cost is real money).
  const windowStart = now.getTime() - ROLE_BUDGET_WINDOW_MS;
  const recent = roleLoops.filter((l) => {
    const t = l.createdAt instanceof Date ? l.createdAt.getTime() : new Date(l.createdAt as unknown as string).getTime();
    return Number.isFinite(t) && t >= windowStart;
  }).length;
  if (recent >= rails.budgetPerDay) return { suppress: "budget" };

  return {};
}

/** Read the role-concern binding off any trigger config without trusting its shape. */
function readRoleConcernBinding(config: unknown): RoleConcernBinding | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const rc = (config as Record<string, unknown>).roleConcern;
  if (typeof rc !== "object" || rc === null) return undefined;
  const { roleId, concernId } = rc as Record<string, unknown>;
  if (typeof roleId === "string" && roleId.length > 0 && typeof concernId === "string" && concernId.length > 0) {
    return { roleId, concernId };
  }
  return undefined;
}

/** Locate a concern on a role by id (defensive — the stored array is jsonb). */
function findConcern(role: StandingRoleRow, concernId: string): StandingRoleConcern | undefined {
  const concerns = (role.concerns ?? []) as StandingRoleConcern[];
  return concerns.find((c) => c && c.id === concernId);
}

/**
 * WAKE a Standing Role because its concern's BACKING trigger fired. The route calls
 * this (instead of `maybeLaunchConsiliumReview` / `maybeLaunchGitHubReview`) when the
 * trigger config carries `roleConcern`. Discriminants mirror the other dispatch paths:
 *   - "noop"          → the trigger carries no role binding (defensive; route pre-checks)
 *   - "noop-event"    → a github concern whose event does not map to a review
 *   - "skipped"       → subsystem off / no project / role missing / role or concern
 *                       DISABLED / concern missing / no resolvable owner — logged, safe
 *   - "skipped-dedup" / "skipped-budget" / "skipped-cascade" → a per-role rail suppressed
 *   - "launched"      → the factory was invoked (role loop, review-only)
 *   - "failed"        → the factory threw (allowlist/workspace/skill rejection) — T4 caught
 */
export async function maybeLaunchRoleWake(
  deps: ConsiliumTriggerDispatchDeps,
  trigger: TriggerRow,
  payload: unknown,
): Promise<ConsiliumDispatchResult> {
  const binding = readRoleConcernBinding(trigger.config);
  if (!binding) return "noop"; // not a role-bound trigger (route only routes here when it is)

  const reviewDeps = deps.reviewDeps;
  if (!reviewDeps) {
    deps.log(`role wake skipped for trigger ${trigger.id} — consilium loop disabled`);
    return "skipped";
  }
  const projectId = trigger.projectId;
  if (!projectId) {
    deps.log(`role wake skipped for trigger ${trigger.id} — trigger has no projectId`);
    return "skipped";
  }

  // Load the role PROJECT-SCOPED (same ALS the dedup read uses). A role/concern lookup
  // that fails is a safe skip, never a throw.
  const role = await deps.runInProject(projectId, () => reviewDeps.storage.getStandingRole(binding.roleId));
  if (!role) {
    deps.log(`role wake skipped for trigger ${trigger.id} — role ${binding.roleId} not found`);
    return "skipped";
  }
  // R2 (§6): a DISABLED role can never spawn work — refuse BEFORE the factory is touched.
  if (!role.enabled) {
    deps.log(`role wake skipped for trigger ${trigger.id} — role ${role.id} is disabled`);
    return "skipped";
  }
  const concern = findConcern(role, binding.concernId);
  if (!concern) {
    deps.log(`role wake skipped for trigger ${trigger.id} — concern ${binding.concernId} not on role ${role.id}`);
    return "skipped";
  }
  // Per-concern kill (default on): a disabled concern's backing trigger never wakes.
  if (concern.enabled === false) {
    deps.log(`role wake skipped for trigger ${trigger.id} — concern ${concern.id} is disabled`);
    return "skipped";
  }

  // Resolve WHAT the fired event is, per trigger class. For github_event we reuse the
  // PURE event→review mapping to target the PR head (ref/baseline); the review SHAPE
  // (preset/rounds/mode) still comes from the ROLE template, not the mapping.
  let ref: string | null | undefined;
  let baselineCommit: string | undefined;
  let eventDescription: string;
  if (trigger.type === "github_event") {
    const eventType = payloadString(payload, "event") ?? "";
    const mapped = mapGitHubEventToReview(eventType, githubBody(payload));
    if (mapped.kind === "noop") {
      deps.log(`role wake no-op for trigger ${trigger.id} — github ${eventType || "?"}: ${mapped.reason}`);
      return "noop-event";
    }
    ref = mapped.mapping.ref;
    baselineCommit = mapped.mapping.baselineCommit;
    eventDescription = mapped.mapping.eventLabel;
  } else {
    // file_change (and any other concern class riding the file/schedule runtime).
    eventDescription = describeEvent(trigger, payload);
  }

  // Compose the loop payload FROM THE ROLE (§3): persona + concern.focus + the event.
  const engineerInstruction = composeRoleTriggerInstruction(role.persona, concern.focus, eventDescription);
  const policy = role.policy ?? {};
  const roleProvenance: RoleProvenance = {
    roleId: role.id,
    name: role.name,
    concernId: concern.id,
    cascadeDepth: 1, // a trigger-born role wake is depth 1 (loop-triggers.md §4.4)
  };

  return launchReviewWithDedup(deps, trigger, {
    projectId,
    // R1: the concern's repoPath — re-validated fail-closed against the allowlist +
    // the project's workspaces INSIDE the factory (never trusted from the stored config).
    repoPath: concern.repoPath,
    preset: role.loopTemplate.preset,
    ref,
    baselineCommit,
    // R4: persona + focus + event, fenced by the factory.
    engineerInstruction,
    // R5: role skills, re-resolved project-scoped by the factory.
    skillIds: role.skills && role.skills.length > 0 ? role.skills : undefined,
    reviewMode: role.loopTemplate.reviewMode,
    roleProvenance,
    // R3: the per-role rails (defaults from server constants when policy omits them).
    roleRails: {
      roleId: role.id,
      concernId: concern.id,
      budgetPerDay: policy.budgetPerDay ?? DEFAULT_ROLE_BUDGET_PER_DAY,
      cascadeCeiling: policy.cascadeDepth ?? DEFAULT_ROLE_CASCADE_CEILING,
    },
    // §6: a human passport label (e.g. "PR #12: …" / "file change at …").
    eventSummary: eventDescription,
    payload,
  });
}
