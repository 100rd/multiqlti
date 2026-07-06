/**
 * role-stamp.ts — TRACK-6 (task-tracker-triggers.md §5, standing-role.md §5): the PURE
 * decision that turns a loaded Standing Role + a firing tracker concern into the
 * `{ role, skills }` STAMP a crystallised spec carries in its frontmatter. Kept pure +
 * unit-testable (no gh / storage / ALS) exactly like `role-compose.ts` and
 * `github-event-map.ts`.
 *
 * WHAT THE STAMP IS (and why it is enough)
 *   The role's INBOX is the tracker; the crystallised SPEC is the task. Stamping the
 *   spec frontmatter `role: <name>` + `skills: [...]` is ALL that is needed for the
 *   merged spec to fire the ROLE's loop: SPEC-1's `buildSpecInstruction` folds `role`
 *   into the objective header and passes `skills` as the loop's skillIds. So the
 *   loop composed on merge carries the role's capability + identity — reusing the
 *   already-shipped spec-watch, NOT a reimplemented wake. The role's persona is not a
 *   spec field (it is the standing instruction on the role); the `role:` name header is
 *   the SPEC-1 contract for role provenance on a spec-fired loop.
 *
 * FAIL-CLOSED GATES (adversarial: a tracker concern must never wake a disabled role or
 * bypass the role's kill-switch)
 *   - A missing role, a role whose `enabled` is false, a concern not on the role, or a
 *     concern whose `enabled` is false ⇒ NO stamp (`{ ok: false, reason }`). The poller
 *     then produces an UNSTAMPED spec (byte-identical to TRACK-1) rather than silently
 *     firing a disabled role's loop. The role's `enabled` column is the authoritative
 *     gate — checked HERE, before any spec is stamped.
 *   - The stamped `skills` are re-resolved PROJECT-SCOPED by the review factory when the
 *     merged spec fires (a foreign id fails closed there), same posture as ROLE-2's wake.
 */
import type { StandingRoleRow } from "@shared/schema";
import type { StandingRoleConcern } from "@shared/types";

/** The stamp applied to a crystallised spec's frontmatter (role name + skills). */
export interface RoleStamp {
  /** The role's stored (human-authored) name → the spec's `role:` header. */
  role: string;
  /** The role's skill ids → the spec's `skills:` (re-resolved fail-closed on fire). */
  skills?: string[];
}

export type RoleStampResult =
  | { ok: true; stamp: RoleStamp }
  | { ok: false; reason: string };

/**
 * Resolve the stamp for a firing tracker concern. PURE. `role` is the already-loaded
 * (project-scoped) role, or undefined when the lookup missed. `concernId` names the
 * concern whose backing trigger fired. Returns the stamp only when the role AND the
 * concern are both enabled; otherwise a typed skip reason (the poller logs it and
 * crystallises an UNSTAMPED spec — never a disabled role's work).
 */
export function resolveRoleStamp(
  role: StandingRoleRow | undefined,
  concernId: string,
): RoleStampResult {
  if (!role) return { ok: false, reason: "role-not-found" };
  if (!role.enabled) return { ok: false, reason: "role-disabled" };

  const concerns = (role.concerns ?? []) as StandingRoleConcern[];
  const concern = concerns.find((c) => c && c.id === concernId);
  if (!concern) return { ok: false, reason: "concern-not-found" };
  // Per-concern kill (default on): a disabled concern never stamps.
  if (concern.enabled === false) return { ok: false, reason: "concern-disabled" };

  const skills = Array.isArray(role.skills) && role.skills.length > 0 ? [...role.skills] : undefined;
  return { ok: true, stamp: { role: role.name, ...(skills ? { skills } : {}) } };
}
