/**
 * Shared run-visibility helper.
 *
 * Callers: routes/activity.ts, routes/authorize-task-group.ts (via isVisible),
 * ws/manager.ts (via isVisible).
 */

/** Minimal user shape the visibility predicate needs (id + role). */
export interface VisibilityUser {
  id?: string;
  role?: string;
}

/**
 * The single ownership-visibility predicate shared by every owner-scoped read in
 * the codebase (authorizeTaskGroup, the activity history filter, and the WS
 * subscribe gate). A row is visible iff the caller is an admin OR the caller
 * owns it. Ownerless rows (ownerId == null) are visible ONLY to admins — the
 * STRICT posture (transcripts/activity/groups are never world-readable).
 *
 * Fail-closed: a caller with no id is never granted visibility.
 */
export function isVisible(
  ownerId: string | null | undefined,
  user: VisibilityUser | undefined,
): boolean {
  if (!user?.id) return false;
  if (user.role === "admin") return true;
  return ownerId != null && ownerId === user.id;
}
