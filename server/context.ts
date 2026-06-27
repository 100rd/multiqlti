import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  projectId?: string;
  userId?: string;
  role?: string;
  /** Set to true for legitimately cross-project background work via runAsSystem(). */
  system?: boolean;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Returns the current project ID from the ALS context.
 *
 * Throws in three situations (fail-closed):
 *   1. No ALS context at all — background/startup caller must use runAsProject()
 *      or runAsSystem() to establish context before calling storage methods.
 *   2. System context (system === true) — getProjectId() is structurally forbidden
 *      in system context so that system code cannot silently read project-scoped
 *      secret data. Use unscopedSystemQuery() for legitimate cross-project reads.
 *   3. ALS context exists but has no projectId — requireProject middleware (PR-0b)
 *      has not been wired, or the background caller should use runAsProject().
 */
export function getProjectId(): string {
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new Error(
      "No request context — this path runs outside a request handler. " +
        "Wrap background/startup callers in runAsProject(projectId, fn) or runAsSystem(reason, fn).",
    );
  }
  if (ctx.system) {
    throw new Error(
      "System context cannot call getProjectId() — system code must never read " +
        "project-scoped data via withProject(). " +
        "Use unscopedSystemQuery(label, fn) for legitimate cross-project reads.",
    );
  }
  if (!ctx.projectId) {
    throw new Error(
      "No projectId in context — ensure the x-project-id header is sent and " +
        "requireProject middleware is wired (PR-0b), " +
        "or use runAsProject(projectId, fn) for background callers.",
    );
  }
  return ctx.projectId;
}

/**
 * Runs fn inside a project-scoped ALS context.
 *
 * Use for background jobs that own a single projectId — e.g., pipeline
 * execution triggered for a specific project, or a trigger that fires
 * once per-project.
 *
 * @example
 *   await runAsProject(pipeline.projectId, async () => {
 *     await storage.updatePipelineRun(runId, { status: "running" });
 *   });
 */
export function runAsProject<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ projectId, userId: "system", role: "owner" }, fn);
}

/**
 * Runs fn inside a system-scoped ALS context for legitimately cross-project
 * background work.
 *
 * HARD RULES enforced by this contract:
 *   (a) Every entry writes a structured audit log record (who/why/when).
 *   (b) getProjectId() THROWS inside system context — use unscopedSystemQuery()
 *       for cross-project DB reads; use runAsProject() for single-project reads.
 *   (c) System context is forbidden from calling issueLease() or reading secret
 *       material — the credential broker enforces this structurally (PR-1b).
 *
 * Naming convention: functions that call runAsSystem should be named getAllXxx
 * or have an "Unscoped" suffix so cross-project reads are greppable in review.
 *
 * @example
 *   await runAsSystem("cron-scheduler-bootstrap", async () => {
 *     const triggers = await storage.getAllEnabledTriggersByType("schedule");
 *     ...
 *   });
 */
export function runAsSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  // Audit record: every system-context entry is logged with a mandatory reason.
  // Replace with your structured logger if one is wired to this module.
  console.info(
    JSON.stringify({ scope: "system-access", reason, at: new Date().toISOString() }),
  );
  return requestContext.run({ system: true, userId: "system", role: "system" }, fn);
}

/**
 * Asserts that the current ALS context is a system context (system === true)
 * and runs the provided query. This is the ONLY sanctioned bypass for
 * project-scoped query filtering — it is explicit, greppable, and audited
 * by the surrounding runAsSystem() call.
 *
 * Cross-project storage methods MUST use this wrapper and follow the getAll*
 * naming convention so they are easy to find in security reviews.
 *
 * @throws if called outside a runAsSystem() context.
 *
 * @example
 *   async getAllEnabledTriggersByType(type: string) {
 *     return unscopedSystemQuery("getAllEnabledTriggersByType", () =>
 *       db.select().from(triggers).where(eq(triggers.type, type))
 *     );
 *   }
 */
export async function unscopedSystemQuery<T>(label: string, q: () => Promise<T>): Promise<T> {
  const ctx = requestContext.getStore();
  if (!ctx?.system) {
    throw new Error(
      `unscopedSystemQuery("${label}") called outside system context — ` +
        "wrap the call site in runAsSystem(reason, fn) first.",
    );
  }
  return q();
}
