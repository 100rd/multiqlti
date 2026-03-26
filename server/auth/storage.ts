import type { User, UserRole, OAuthProvider } from "@shared/types";
import type { InsertUser } from "@shared/schema";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IAuthStorage {
  // User queries
  hasUsers(): Promise<boolean>;
  createUser(data: InsertUser): Promise<User>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserById(id: string): Promise<User | undefined>;
  getAllUsers(): Promise<User[]>;

  // OAuth queries
  getUserByOAuth(provider: OAuthProvider, oauthId: string): Promise<User | undefined>;

  // User mutations
  updateUser(
    id: string,
    updates: { name?: string; email?: string; passwordHash?: string; lastLoginAt?: Date; avatarUrl?: string },
  ): Promise<User>;
  updateUserRole(id: string, role: UserRole): Promise<User>;
  deactivateUser(id: string): Promise<User>;
  linkOAuth(userId: string, provider: OAuthProvider, oauthId: string, avatarUrl?: string): Promise<User>;

  // Password hash retrieval (kept separate from User to avoid leaking it)
  getPasswordHashByEmail(email: string): Promise<string | undefined>;

  // Sessions
  createSession(sessionId: string, userId: string, token: string, expiresAt: Date): Promise<void>;
  getSession(token: string): Promise<{ id: string; userId: string; expiresAt: Date } | undefined>;
  deleteSession(token: string): Promise<void>;
  deleteSessionById(id: string): Promise<void>;
  deleteSessionsByUserId(userId: string): Promise<void>;
}

// ─── In-memory implementation (no DATABASE_URL) ───────────────────────────────

interface StoredUser extends User {
  passwordHash: string | null;
}

interface StoredSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

export class MemAuthStorage implements IAuthStorage {
  private usersById = new Map<string, StoredUser>();
  private usersByEmail = new Map<string, StoredUser>();
  private usersByOAuth = new Map<string, StoredUser>(); // key = "provider:oauthId"
  private sessions = new Map<string, StoredSession>();

  async hasUsers(): Promise<boolean> {
    return this.usersById.size > 0;
  }

  async createUser(data: InsertUser): Promise<User> {
    if (this.usersByEmail.has(data.email)) {
      throw new Error("duplicate key value violates unique constraint users_email_unique");
    }
    if (data.oauthProvider && data.oauthId) {
      const oauthKey = `${data.oauthProvider}:${data.oauthId}`;
      if (this.usersByOAuth.has(oauthKey)) {
        throw new Error("duplicate key value violates unique constraint users_oauth_provider_id");
      }
    }
    const id = crypto.randomUUID();
    const now = new Date();
    const stored: StoredUser = {
      id,
      email: data.email,
      name: data.name,
      passwordHash: data.passwordHash ?? null,
      isActive: data.isActive ?? true,
      role: (data.role as UserRole | undefined) ?? "user",
      oauthProvider: (data.oauthProvider as OAuthProvider | undefined) ?? null,
      oauthId: data.oauthId ?? null,
      avatarUrl: data.avatarUrl ?? null,
      lastLoginAt: null,
      createdAt: now,
    };
    this.usersById.set(id, stored);
    this.usersByEmail.set(data.email, stored);
    if (stored.oauthProvider && stored.oauthId) {
      this.usersByOAuth.set(`${stored.oauthProvider}:${stored.oauthId}`, stored);
    }
    return this.toUser(stored);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const stored = this.usersByEmail.get(email);
    return stored ? this.toUser(stored) : undefined;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const stored = this.usersById.get(id);
    return stored ? this.toUser(stored) : undefined;
  }

  async getUserByOAuth(provider: OAuthProvider, oauthId: string): Promise<User | undefined> {
    const stored = this.usersByOAuth.get(`${provider}:${oauthId}`);
    return stored ? this.toUser(stored) : undefined;
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.usersById.values()).map((s) => this.toUser(s));
  }

  async updateUser(
    id: string,
    updates: { name?: string; email?: string; passwordHash?: string; lastLoginAt?: Date; avatarUrl?: string },
  ): Promise<User> {
    const stored = this.usersById.get(id);
    if (!stored) throw new Error("User not found");

    if (updates.email !== undefined && updates.email !== stored.email) {
      if (this.usersByEmail.has(updates.email)) {
        throw new Error("duplicate key value violates unique constraint users_email_unique");
      }
      this.usersByEmail.delete(stored.email);
      stored.email = updates.email;
      this.usersByEmail.set(updates.email, stored);
    }
    if (updates.name !== undefined) stored.name = updates.name;
    if (updates.passwordHash !== undefined) stored.passwordHash = updates.passwordHash;
    if (updates.lastLoginAt !== undefined) stored.lastLoginAt = updates.lastLoginAt;
    if (updates.avatarUrl !== undefined) stored.avatarUrl = updates.avatarUrl;

    return this.toUser(stored);
  }

  async updateUserRole(id: string, role: UserRole): Promise<User> {
    const stored = this.usersById.get(id);
    if (!stored) throw new Error("User not found");
    stored.role = role;
    return this.toUser(stored);
  }

  async deactivateUser(id: string): Promise<User> {
    const stored = this.usersById.get(id);
    if (!stored) throw new Error("User not found");
    stored.isActive = false;
    await this.deleteSessionsByUserId(id);
    return this.toUser(stored);
  }

  async linkOAuth(
    userId: string,
    provider: OAuthProvider,
    oauthId: string,
    avatarUrl?: string,
  ): Promise<User> {
    const stored = this.usersById.get(userId);
    if (!stored) throw new Error("User not found");
    const oauthKey = `${provider}:${oauthId}`;
    if (this.usersByOAuth.has(oauthKey)) {
      throw new Error("duplicate key value violates unique constraint users_oauth_provider_id");
    }
    // Remove old OAuth mapping if switching
    if (stored.oauthProvider && stored.oauthId) {
      this.usersByOAuth.delete(`${stored.oauthProvider}:${stored.oauthId}`);
    }
    stored.oauthProvider = provider;
    stored.oauthId = oauthId;
    if (avatarUrl !== undefined) stored.avatarUrl = avatarUrl;
    this.usersByOAuth.set(oauthKey, stored);
    return this.toUser(stored);
  }

  async getPasswordHashByEmail(email: string): Promise<string | undefined> {
    return this.usersByEmail.get(email)?.passwordHash ?? undefined;
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

  async deleteSessionsByUserId(userId: string): Promise<void> {
    for (const [token, s] of this.sessions) {
      if (s.userId === userId) {
        this.sessions.delete(token);
      }
    }
  }

  private toUser(s: StoredUser): User {
    return {
      id: s.id,
      email: s.email,
      name: s.name,
      isActive: s.isActive,
      role: s.role,
      oauthProvider: s.oauthProvider,
      oauthId: s.oauthId,
      avatarUrl: s.avatarUrl,
      lastLoginAt: s.lastLoginAt,
      createdAt: s.createdAt,
    };
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

  async getUserByOAuth(provider: OAuthProvider, oauthId: string): Promise<User | undefined> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const [row] = await db
      .select()
      .from(users)
      .where(and(eq(users.oauthProvider, provider), eq(users.oauthId, oauthId)));
    return row ? this.rowToUser(row) : undefined;
  }

  async getAllUsers(): Promise<User[]> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const rows = await db.select().from(users);
    return rows.map((r) => this.rowToUser(r));
  }

  async updateUser(
    id: string,
    updates: { name?: string; email?: string; passwordHash?: string; lastLoginAt?: Date; avatarUrl?: string },
  ): Promise<User> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.email !== undefined) setValues.email = updates.email;
    if (updates.passwordHash !== undefined) setValues.passwordHash = updates.passwordHash;
    if (updates.lastLoginAt !== undefined) setValues.lastLoginAt = updates.lastLoginAt;
    if (updates.avatarUrl !== undefined) setValues.avatarUrl = updates.avatarUrl;
    const [updated] = await db.update(users).set(setValues).where(eq(users.id, id)).returning();
    if (!updated) throw new Error("User not found");
    return this.rowToUser(updated);
  }

  async updateUserRole(id: string, role: UserRole): Promise<User> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [updated] = await db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!updated) throw new Error("User not found");
    return this.rowToUser(updated);
  }

  async deactivateUser(id: string): Promise<User> {
    const { db } = await import("../db");
    const { users, sessions } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [updated] = await db
      .update(users)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!updated) throw new Error("User not found");
    await db.delete(sessions).where(eq(sessions.userId, id));
    return this.rowToUser(updated);
  }

  async linkOAuth(
    userId: string,
    provider: OAuthProvider,
    oauthId: string,
    avatarUrl?: string,
  ): Promise<User> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const setValues: Record<string, unknown> = {
      oauthProvider: provider,
      oauthId,
      updatedAt: new Date(),
    };
    if (avatarUrl !== undefined) setValues.avatarUrl = avatarUrl;
    const [updated] = await db
      .update(users)
      .set(setValues)
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new Error("User not found");
    return this.rowToUser(updated);
  }

  async getPasswordHashByEmail(email: string): Promise<string | undefined> {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(users).where(eq(users.email, email));
    return row?.passwordHash ?? undefined;
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

  async deleteSessionsByUserId(userId: string): Promise<void> {
    const { db } = await import("../db");
    const { sessions } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(sessions).where(eq(sessions.userId, userId));
  }

  private rowToUser(row: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    role: UserRole;
    oauthProvider: string | null;
    oauthId: string | null;
    avatarUrl: string | null;
    lastLoginAt: Date | null;
    createdAt: Date;
  }): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      isActive: row.isActive,
      role: row.role,
      oauthProvider: row.oauthProvider as OAuthProvider | null,
      oauthId: row.oauthId,
      avatarUrl: row.avatarUrl,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
    };
  }
}

// ─── Singleton selection ──────────────────────────────────────────────────────

import { configLoader } from "../config/loader";

export const authStorage: IAuthStorage = configLoader.get().database.url
  ? new PgAuthStorage()
  : new MemAuthStorage();
