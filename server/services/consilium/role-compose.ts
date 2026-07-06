/**
 * role-compose.ts — the ONE pure seam that composes a Standing Role wake's engineer
 * instruction (standing-role.md §3). Shared by BOTH wake paths so they cannot drift:
 *   - ROLE-1 manual wake  (routes/standing-roles.ts, POST /api/roles/:id/wake)
 *   - ROLE-2 trigger wake (services/consilium/trigger-dispatch.ts, maybeLaunchRoleWake)
 *
 * PURE + unit-testable. It ONLY JOINS text — ALL sanitisation happens in the review
 * factory (`untrustedExtraBlock`: control-strip + byte-clamp + a strictly-longer
 * backtick fence) before the string enters the loop objective. Neither the stored
 * persona nor the (per-wake / per-concern) focus can break out to inject instructions;
 * the fence is a SINGLE downstream seam, never re-done here.
 */

/** The literal token a concern focus may embed to interpolate the firing event (§3). */
const EVENT_TOKEN = "${event}";

/**
 * Compose a wake's engineer instruction = `persona + focus`. The factory fences the
 * whole string as data. Used verbatim by the ROLE-1 manual wake.
 */
export function composeWakeInstruction(persona: string, focus: string): string {
  return `${persona}\n\n## Focus\n${focus}`;
}

/**
 * ROLE-2: compose a TRIGGER wake's instruction = `persona + concern.focus + the fired
 * event`. If the focus embeds the literal `${event}` token it is interpolated in place
 * (mirrors the trigger action's `${event}` seam); otherwise a short, inert
 * "(triggered by: …)" line is appended so the loop knows what woke it. The event
 * description is UNTRUSTED (embeds fs paths / a PR title) — safe to join here because
 * the factory fences the composed string. Split/join replaces EVERY `${event}` without
 * invoking regex `$`-pattern semantics on the untrusted description.
 */
export function composeRoleTriggerInstruction(
  persona: string,
  focus: string,
  eventDescription: string,
): string {
  const focusWithEvent = focus.includes(EVENT_TOKEN)
    ? focus.split(EVENT_TOKEN).join(eventDescription)
    : `${focus}\n\n(triggered by: ${eventDescription})`;
  return composeWakeInstruction(persona, focusWithEvent);
}
