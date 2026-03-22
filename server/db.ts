import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "@shared/schema";
import { configLoader } from "./config/loader";
import path from "path";

// database.url is optional — PgStorage will throw at query time if absent,
// but importing this module is safe even when DATABASE_URL is not set (e.g. in tests).
export const pool = new Pool({ connectionString: configLoader.get().database.url });

export const db = drizzle(pool, { schema });

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
