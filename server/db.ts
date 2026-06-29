import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "@shared/schema";
import { configLoader } from "./config/loader";
import path from "path";

// database.url is optional — PgStorage will throw at query time if absent,
// but importing this module is safe even when DATABASE_URL is not set (e.g. in tests).
export const pool = new Pool({ connectionString: configLoader.get().database.url });

// A dropped Postgres connection (container restart, machine sleep, or a server
// "terminating connection due to administrator command") makes node-postgres
// emit an 'error' event on the affected idle client. With NO listener Node
// rethrows it as an unhandled 'error' and crashes the ENTIRE process — which is
// exactly how this server died on infra blips. Log and swallow instead: the
// pool drops the bad client and transparently establishes a fresh connection on
// the next query, so a transient DB hiccup no longer takes the server down.
pool.on("error", (err: Error) => {
  console.error("[db] idle pool client error (recovering, not fatal):", err.message);
});

export const db = drizzle(pool, { schema });

import { requestContext } from "./context";
import { SQL, and, eq, or, isNull } from "drizzle-orm";

/**
 * Helper to wrap any Drizzle query condition with the current project ID filter.
 *
 * FAIL-CLOSED: throws rather than silently bypassing isolation when no project
 * context is present. Callers outside a request handler MUST be wrapped in
 * runAsProject(projectId, fn) or runAsSystem(reason, fn).
 *
 * System context (runAsSystem) is allowed to call withProject for SELECT queries
 * but the project filter is NOT applied — the query runs cross-project.  The
 * audit trail is provided by the surrounding runAsSystem() call. System context
 * callers must NOT use withProject to access secret material (enforced at the
 * broker layer in PR-1b).
 *
 * Usage: db.select().from(table).where(withProject(table, eq(table.id, id)))
 */
export function withProject(table: any, condition?: SQL | undefined): SQL {
  const ctx = requestContext.getStore();

  if (!ctx) {
    throw new Error(
      "withProject: no request context — this path runs outside a request handler. " +
        "Wrap background/startup callers in runAsProject(projectId, fn) or runAsSystem(reason, fn). " +
        "See server/context.ts and ADR-001 §3.1(c)/(d).",
    );
  }

  if (ctx.system) {
    // System context: the runAsSystem() audit trail covers this cross-project read.
    // Do NOT apply a project filter — system code reads across all projects by design.
    // System context is structurally prohibited from accessing secret material (PR-1b).
    if (!condition) {
      throw new Error(
        "withProject: system context SELECT requires a WHERE condition — " +
          "pass a filter expression or use unscopedSystemQuery(label, fn) explicitly.",
      );
    }
    return condition;
  }

  if (!ctx.projectId) {
    throw new Error(
      "withProject: no projectId in context — ensure the x-project-id header is sent " +
        "and requireProject middleware is wired (PR-0b), " +
        "or use runAsProject(projectId, fn) for background callers.",
    );
  }

  // Sanity-check: table must have a projectId column. Tables that don't have it
  // yet (e.g. provider_keys, argocd_config, triggers pre-PR-0c) will be caught
  // here at development/test time rather than silently bypassing isolation.
  if (table.projectId === undefined) {
    throw new Error(
      'withProject: table has no "projectId" column — ' +
        "add the column in PR-0c before enabling project scoping on this table.",
    );
  }

  const projectFilter = eq(table.projectId, ctx.projectId);
  return condition ? and(projectFilter, condition)! : projectFilter;
}

/**
 * Project-scoping helper for NON-SECRET LIST tables (pipelines, pipeline_runs,
 * skills, task_groups, and the parent tables used to scope traces / consilium
 * loops).
 *
 * Same per-project filter as withProject in a request context, but — unlike
 * withProject — a SYSTEM context (runAsSystem) is permitted to read
 * cross-project even with NO extra condition: it returns the (possibly
 * undefined) condition, i.e. "no project filter = all rows", audited by the
 * surrounding runAsSystem() call. This is exactly what legitimate cross-project
 * background callers need: config-sync CLI, federation peer sync, catalog
 * reconcile, the consilium-loop sweep poller, and startup seeds.
 *
 * withProject (strict — throws on system + no-condition) is deliberately
 * retained for SECRET tables (provider_keys, argocd_config, …) so system code
 * cannot silently enumerate every project's secret rows. Use withProjectList
 * ONLY for non-secret, listable data.
 *
 * FAIL-CLOSED on missing context.
 *
 * Usage: db.select().from(pipelines).where(withProjectList(pipelines))
 */
export function withProjectList(table: any, condition?: SQL | undefined): SQL | undefined {
  const ctx = requestContext.getStore();

  if (!ctx) {
    throw new Error(
      "withProjectList: no request context — wrap background/startup callers in " +
        "runAsProject(projectId, fn) or runAsSystem(reason, fn). See server/context.ts.",
    );
  }

  if (ctx.system) {
    // System context: cross-project read, audited by runAsSystem().
    // undefined condition → no WHERE filter → all rows across every project.
    return condition;
  }

  if (!ctx.projectId) {
    throw new Error(
      "withProjectList: no projectId in context — ensure the x-project-id header " +
        "is sent and requireProject middleware is wired, or use runAsProject(projectId, fn).",
    );
  }

  if (table.projectId === undefined) {
    throw new Error(
      'withProjectList: table has no "projectId" column — use a subquery through a ' +
        "project-scoped parent table instead.",
    );
  }

  const projectFilter = eq(table.projectId, ctx.projectId);
  return condition ? and(projectFilter, condition)! : projectFilter;
}

/**
 * Project-scoping helper for GLOBAL-CATALOG tables (e.g. `models`).
 *
 * Unlike withProject (strict per-project isolation), this implements
 * "global-or-current-project" visibility:
 *
 *     project_id IS NULL          -- the shared, cross-project catalog
 *   OR project_id = <ctx.projectId>  -- this project's own private entries
 *
 * Product decision (ADR-001 / strict-project-isolation): the LLM model catalog
 * is GLOBAL. Rows seeded by the startup reconcile run in system context and are
 * stamped projectId=NULL (see withProjectInsert), so they remain visible in
 * every project. A model created inside a specific project (non-null projectId)
 * is visible ONLY in that project.
 *
 * FAIL-CLOSED on missing context, same as withProject.
 *
 * System context (runAsSystem) sees ALL rows (global + every project) so the
 * startup seed/reconcile can compare against, upsert, and deactivate the whole
 * catalog. This is audited by the surrounding runAsSystem() call. Returns
 * `undefined` (no WHERE filter) when no extra condition is supplied in system
 * context — Drizzle treats `.where(undefined)` as "no filter".
 *
 * Usage: db.select().from(models).where(withProjectOrGlobal(models, eq(models.isActive, true)))
 */
export function withProjectOrGlobal(table: any, condition?: SQL | undefined): SQL | undefined {
  const ctx = requestContext.getStore();

  if (!ctx) {
    throw new Error(
      "withProjectOrGlobal: no request context — this path runs outside a request handler. " +
        "Wrap background/startup callers in runAsProject(projectId, fn) or runAsSystem(reason, fn). " +
        "See server/context.ts and ADR-001 §3.1(c)/(d).",
    );
  }

  if (ctx.system) {
    // System context: catalog reconcile/seed must see the WHOLE catalog (global
    // rows + every project's private rows) so it can diff/upsert/deactivate.
    // Audited by the surrounding runAsSystem() call. No project filter applied.
    return condition;
  }

  if (!ctx.projectId) {
    throw new Error(
      "withProjectOrGlobal: no projectId in context — ensure the x-project-id header is sent " +
        "and requireProject middleware is wired (PR-0b), " +
        "or use runAsProject(projectId, fn) for background callers.",
    );
  }

  if (table.projectId === undefined) {
    throw new Error(
      'withProjectOrGlobal: table has no "projectId" column — global-catalog visibility ' +
        "requires a nullable project_id column on the table.",
    );
  }

  // Global-or-current visibility: shared catalog rows (project_id IS NULL) PLUS
  // the current project's own rows.
  const visibility = or(isNull(table.projectId), eq(table.projectId, ctx.projectId))!;
  return condition ? and(visibility, condition)! : visibility;
}

/**
 * Helper to inject the current project ID into data for insert operations.
 *
 * FAIL-CLOSED: throws when no context is present.
 *
 * In system context (runAsSystem) sets projectId to null, creating globally
 * visible rows (e.g. seeded default models, built-in skills, pipeline templates).
 * This matches the pre-existing schema design where nullable projectId means
 * "shared across all projects".
 *
 * Usage: db.insert(table).values(withProjectInsert(table, data))
 */
export function withProjectInsert<T>(table: any, data: T): T & { projectId: string | null } {
  const ctx = requestContext.getStore();

  if (!ctx) {
    throw new Error(
      "withProjectInsert: no request context — wrap background/startup inserts in " +
        "runAsProject(projectId, fn) or runAsSystem(reason, fn). " +
        "See server/context.ts and ADR-001 §3.1(c)/(d).",
    );
  }

  if (ctx.system) {
    // System context: insert with projectId=null (globally shared / unscoped data).
    // Use for system-level seeding that creates resources shared across all projects.
    if (Array.isArray(data)) {
      return data.map((item) => ({ ...item, projectId: null })) as unknown as T & { projectId: string | null };
    }
    return { ...data, projectId: null } as unknown as T & { projectId: string | null };
  }

  if (!ctx.projectId) {
    throw new Error(
      "withProjectInsert: no projectId in context — ensure requireProject middleware " +
        "is wired (PR-0b) or use runAsProject(projectId, fn) for background inserts.",
    );
  }

  if (Array.isArray(data)) {
    return data.map((item) => ({ ...item, projectId: ctx.projectId! })) as unknown as T & { projectId: string | null };
  }
  return { ...data, projectId: ctx.projectId } as unknown as T & { projectId: string | null };
}

/**
 * Run pending Drizzle migrations on startup.
 * Safe to call multiple times — already-applied migrations are skipped.
 * Resolves silently when DATABASE_URL is not set (MemStorage mode).
 *
 * If the schema was already created via `drizzle-kit push`, migrations
 * will fail with "relation already exists" (42P07). We treat this as a
 * non-fatal condition: the schema is already up-to-date.
 */
export async function runMigrations(): Promise<void> {
  if (!configLoader.get().database.url) return;
  try {
    await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname ?? __dirname, "../migrations") });
    console.log("[db] migrations applied");
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "42P07") {
      // "relation already exists" — schema was created by `drizzle-kit push`
      console.log("[db] schema already up-to-date (created via push), skipping migrations");
      return;
    }
    console.error("[db] migration failed:", err);
    throw err;
  }
}
