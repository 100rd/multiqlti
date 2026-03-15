import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";
import { configLoader } from "./config/loader";

// db is only imported by PgStorage, which is only instantiated when database.url is set.
// The pool constructor is deferred so that importing this module does not throw
// when database.url is absent — MemStorage is used in that case.
const connectionString = configLoader.get().database.url;

const pool = new Pool({ connectionString });

export const db = drizzle(pool, { schema });
