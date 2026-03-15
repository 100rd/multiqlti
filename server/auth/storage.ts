import type { User } from "@shared/types";
import type { InsertUser } from "@shared/schema";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IAuthStorage {
  hasUsers(): Promise<boolean>;
  createUser(data: InsertUser): Promise<User>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserById(id: string): Promise<User | undefined>;
  createSession(sessionId: string, userId: string, token: string, expiresAt: Date): Promise<void>;
  getSession(token: string): Promise<{ id: string; userId: string; expiresAt: Date } | undefined>;
  deleteSession(token: string): Promise<void>;
  deleteSessionById(id: string): Promise<void>;
}

// ─── In-memory implementation (no DATABASE_URL) ───────────────────────────────

interface StoredUser extends User {
  passwordHash: string;
}

interface StoredSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

export class MemAuthStorage implements IAuthStorage {
  private users = new Map<string, StoredUser>();
  private usersByEmail = new Map<string, StoredUser>();
  private sessions = new Map<string, StoredSession>();

  async hasUsers(): Promise<boolean> {
    return this.users.size > 0;
  }

  async createUser(data: InsertUser): Promise<User> {
    if (this.usersByEmail.has(data.email)) {
      throw new Error("duplicate key value violates unique constraint users_email_unique");
    }
    const id = crypto.randomUUID();
    const now = new Date();
    const stored: StoredUser = {
      id,
      email: data.email,
      name: data.name,
      passwordHash: data.passwordHash,
      isActive: data.isActive ?? true,
      createdAt: now,
    };
    this.users.set(id, stored);
    this.usersByEmail.set(data.email, stored);
    return this.toUser(stored);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const stored = this.usersByEmail.get(email);
    return stored ? this.toUser(stored) : undefined;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const stored = this.users.get(id);
    return stored ? this.toUser(stored) : undefined;
  }

  /** Returns the password hash for bcrypt comparison — stored separately from User. */
  getPasswordHash(userId: string): string | undefined {
    return this.users.get(userId)?.passwordHash;
  }

  async createSession(
    sessionId: string,
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    this.sessions.set(token, { id: sessionId, userId, token, expiresAt });
  }

  async getSession(
    token: string,
  ): Promise<{ id: string; userId: string; expiresAt: Date } | undefined> {
    const s = this.sessions.get(token);
    if (!s) return undefined;
    return { id: s.id, userId: s.userId, expiresAt: s.expiresAt };
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async deleteSessionById(id: string): Promise<void> {
    for (const [token, s] of this.sessions) {
      if (s.id === id) {
        this.sessions.delete(token);
        return;
      }
    }
  }

  private toUser(s: StoredUser): User {
    return { id: s.id, email: s.email, name: s.name, isActive: s.isActive, createdAt: s.createdAt };
  }
}

// ─── PostgreSQL implementation ────────────────────────────────────────────────

export class PgAuthStorage implements IAuthStorage {
  async hasUsers(): Promise<boolean> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { count } = await import("drizzle-orm");
    const result = await db.select({ total: count() }).from(users);
    return (result[0]?.total ?? 0) > 0;
  }

  async createUser(data: InsertUser): Promise<User> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const [row] = await db.insert(users).values(data).returning();
    return this.rowToUser(row);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(users).where(eq(users.email, email));
    return row ? this.rowToUser(row) : undefined;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row ? this.rowToUser(row) : undefined;
  }

  async getPasswordHashFromDb(email: string): Promise<string | undefined> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(users).where(eq(users.email, email));
    return row?.passwordHash;
  }

  async createSession(
    sessionId: string,
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    const { db } = await import("../db");
    const { sessions } = await import("@shared/schema");
    await db.insert(sessions).values({ id: sessionId, userId, token, expiresAt });
  }

  async getSession(
    token: string,
  ): Promise<{ id: string; userId: string; expiresAt: Date } | undefined> {
    const { db } = await import("../db");
    const { sessions } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(sessions).where(eq(sessions.token, token));
    if (!row) return undefined;
    return { id: row.id, userId: row.userId, expiresAt: row.expiresAt };
  }

  async deleteSession(token: string): Promise<void> {
    const { db } = await import("../db");
    const { sessions } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  async deleteSessionById(id: string): Promise<void> {
    const { db } = await import("../db");
    const { sessions } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(sessions).where(eq(sessions.id, id));
  }

  private rowToUser(row: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    createdAt: Date;
  }): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      isActive: row.isActive,
      createdAt: row.createdAt,
    };
  }
}

// ─── Singleton selection ──────────────────────────────────────────────────────

import { configLoader } from "../config/loader";

export const authStorage: IAuthStorage = configLoader.get().database.url
  ? new PgAuthStorage()
  : new MemAuthStorage();
