import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";

// db is only imported by PgStorage, which is only instantiated when DATABASE_URL is set.
// The pool constructor is deferred so that importing this module does not throw
// when DATABASE_URL is absent — MemStorage is used in that case.
const connectionString = process.env.DATABASE_URL ?? "";

const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });
