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
import { SQL, and, eq } from "drizzle-orm";

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
export function withProjectInsert<T>(table: any, data: T): T {
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
      return data.map((item) => ({ ...item, projectId: null })) as unknown as T;
    }
    return { ...data, projectId: null } as unknown as T;
  }

  if (!ctx.projectId) {
    throw new Error(
      "withProjectInsert: no projectId in context — ensure requireProject middleware " +
        "is wired (PR-0b) or use runAsProject(projectId, fn) for background inserts.",
    );
  }

  if (Array.isArray(data)) {
    return data.map((item) => ({ ...item, projectId: ctx.projectId! })) as unknown as T;
  }
  return { ...data, projectId: ctx.projectId } as unknown as T;
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
