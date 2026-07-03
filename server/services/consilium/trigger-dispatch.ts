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
import { dirname, join } from "path";
import {
  CONSILIUM_LOOP_TERMINAL_STATES,
  type TriggerRow,
  type ConsiliumLoopRow,
} from "@shared/schema";
import type {
  ConsiliumReviewTriggerAction,
  TriggerProvenance,
} from "@shared/types";
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
  | "noop"
  | "failed";

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

  // §6 provenance: which trigger + event fired the loop (short payload digest, not
  // the untrusted payload verbatim). Persisted inert for the launch passport.
  const provenance: TriggerProvenance = {
    triggerId: trigger.id,
    triggerType: trigger.type,
    eventDigest: eventDigest(payload),
    firedAt: new Date().toISOString(),
  };

  // T5: dedup key — match against the CANONICAL path the factory persists.
  const resolvedRepo = canonicalRepoPath(repoPath);

  // FK FIX: a trigger-launched review has no `req.user`. `task_groups.created_by`
  // is an FK to `users.id`, so the old literal `createdBy: "system"` violated
  // `task_groups_created_by_users_id_fk` and every trigger review failed. Resolve
  // the PROJECT OWNER (a real user id) instead. Inside the try so a lookup throw
  // is caught (T4) rather than crashing the watcher loop.
  const reviewDeps = deps.reviewDeps;
  let dedupLoopId: string | undefined;
  try {
    const createdBy = await deps.resolveOwnerId(projectId);
    if (!createdBy) {
      // No resolvable owner ⇒ no valid FK target ⇒ do NOT call the factory.
      deps.log(
        `consilium_review skipped for trigger ${trigger.id} — no resolvable owner for project ${projectId}`,
      );
      return "skipped";
    }

    const loop = await deps.runInProject(projectId, async (): Promise<ConsiliumLoopRow | null> => {
      // T5 (FIX HIGH-1): active-loop DEDUP on the TRIGGER path. `getLoops()` is
      // project-scoped by this ALS context, so we only see THIS project's loops.
      // Skip if a NON-TERMINAL consilium loop already targets this repoPath — a
      // burst of file events must not fan out into unbounded heavy-model disputes.
      // (The explicit UI endpoint calls the factory directly and is NOT deduped.)
      const existing = await reviewDeps.storage.getLoops();
      const active = existing.find(
        (l) =>
          !TERMINAL_LOOP_STATES.has(l.state) &&
          (l.repoPath === resolvedRepo || l.repoPath === repoPath),
      );
      if (active) {
        dedupLoopId = active.id;
        return null; // signal: deduped, do NOT launch the factory
      }

      return deps.createReview(reviewDeps, {
        projectId,
        repoPath,
        preset: action.preset,
        // FK FIX: real `users.id` (project owner), NOT the literal "system".
        createdBy,
        // T6 (FIX MED-2): FORCE review-only on EVERY trigger path (file_change AND
        // schedule). An unattended, automatically-fired run must NEVER reach
        // DEVELOPING / the SDLC coder, so we IGNORE `action.maxRounds` here
        // (server-side, not config-trusted). Multi-round (1..6) is reachable ONLY
        // via the human UI endpoint. The operator's chosen maxRounds is persisted on
        // the template for a future (T-full) attended path but is inert today.
        maxRounds: 1,
        // T1: exactly one of these is set (engineerInstruction wins in the factory).
        engineerInstruction,
        objectiveExtra,
        // §6: record which trigger + event started the loop.
        triggerProvenance: provenance,
      });
    });

    if (loop === null) {
      deps.log(
        `consilium_review skipped-dedup for trigger ${trigger.id} — active loop ${dedupLoopId} already running for ${resolvedRepo}`,
      );
      return "skipped-dedup";
    }

    deps.log(
      `consilium_review launched for trigger ${trigger.id} (preset ${action.preset}, loop ${loop.id})`,
    );
    return "launched";
  } catch (e) {
    // T4: never throw out of the watcher loop on a poisoned config.
    deps.log(`consilium_review for trigger ${trigger.id} rejected: ${(e as Error).message}`);
    return "failed";
  }
}
