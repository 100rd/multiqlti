import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@shared/schema";
import { configLoader } from "./config/loader";

// database.url is optional — PgStorage will throw at query time if absent,
// but importing this module is safe even when DATABASE_URL is not set (e.g. in tests).
const pool = new Pool({ connectionString: configLoader.get().database.url });

export const db = drizzle(pool, { schema });
