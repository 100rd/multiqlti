import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db";
import { users, sessions } from "@shared/schema";
import { eq, count } from "drizzle-orm";
import type { User, AuthSession, UserRole } from "@shared/types";
import { configLoader } from "../config/loader";

interface JwtPayload {
  userId: string;
  sessionId: string;
}

function rowToUser(row: {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role: UserRole;
  lastLoginAt: Date | null;
  createdAt: Date;
}): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isActive: row.isActive,
    role: row.role,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

class AuthService {
  async hasUsers(): Promise<boolean> {
    const result = await db.select({ total: count() }).from(users);
    return (result[0]?.total ?? 0) > 0;
  }

  async register(email: string, name: string, password: string): Promise<AuthSession> {
    // Check if any users exist — first user becomes admin, rest are blocked
    const userCount = await db.select({ total: count() }).from(users);
    const total = userCount[0]?.total ?? 0;

    if (total > 0) {
      const err = new Error("Registration is closed — admin account already exists");
      (err as NodeJS.ErrnoException).code = "REGISTRATION_CLOSED";
      throw err;
    }

    const { bcryptRounds } = configLoader.get().auth;
    const passwordHash = await bcrypt.hash(password, bcryptRounds);

    // First user is always admin
    const [user] = await db
      .insert(users)
      .values({ email, name, passwordHash, role: "admin" })
      .returning();

    return this.createSession(user);
  }

  async login(email: string, password: string): Promise<AuthSession> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    if (!user) {
      throw new Error("Invalid credentials");
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new Error("Invalid credentials");
    }

    if (!user.isActive) {
      throw new Error("Account is disabled");
    }

    // Update last_login_at
    await db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    const updatedUser = { ...user, lastLoginAt: new Date() };
    return this.createSession(updatedUser);
  }

  async logout(token: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  async validateToken(token: string): Promise<User | null> {
    const { jwtSecret } = configLoader.get().auth;
    if (!jwtSecret) return null;
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, jwtSecret) as JwtPayload;
    } catch {
      return null;
    }

    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token));

    if (!session) return null;
    if (session.expiresAt < new Date()) {
      await db.delete(sessions).where(eq(sessions.id, session.id));
      return null;
    }
    if (session.userId !== payload.userId) return null;

    const [user] = await db.select().from(users).where(eq(users.id, payload.userId));
    if (!user || !user.isActive) return null;

    return rowToUser(user);
  }

  async getUserById(id: string): Promise<User | null> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) return null;
    return rowToUser(user);
  }

  async getAllUsers(): Promise<User[]> {
    const rows = await db.select().from(users);
    return rows.map(rowToUser);
  }

  async updateUser(id: string, updates: { name?: string; email?: string; password?: string }): Promise<User> {
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.email !== undefined) setValues.email = updates.email;
    if (updates.password !== undefined) {
      const { bcryptRounds } = configLoader.get().auth;
      setValues.passwordHash = await bcrypt.hash(updates.password, bcryptRounds);
    }

    const [updated] = await db
      .update(users)
      .set(setValues)
      .where(eq(users.id, id))
      .returning();

    if (!updated) throw new Error("User not found");
    return rowToUser(updated);
  }

  async updateUserRole(id: string, role: UserRole): Promise<User> {
    const [updated] = await db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (!updated) throw new Error("User not found");
    return rowToUser(updated);
  }

  async deactivateUser(id: string): Promise<User> {
    const [updated] = await db
      .update(users)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (!updated) throw new Error("User not found");
    // Invalidate all sessions for the deactivated user
    await db.delete(sessions).where(eq(sessions.userId, id));
    return rowToUser(updated);
  }

  private async createSession(user: {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    role: UserRole;
    lastLoginAt: Date | null;
    createdAt: Date;
  }): Promise<AuthSession> {
    const { jwtSecret, sessionTtlDays } = configLoader.get().auth;
    if (!jwtSecret) throw new Error("[auth] JWT_SECRET is not configured");
    const sessionMs = sessionTtlDays * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + sessionMs);
    const sessionId = crypto.randomUUID();

    const token = jwt.sign(
      { userId: user.id, sessionId } satisfies JwtPayload,
      jwtSecret,
      { expiresIn: `${sessionTtlDays}d` },
    );

    await db.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      token,
      expiresAt,
    });

    return {
      token,
      user: rowToUser(user),
      expiresAt,
    };
  }
}

export const authService = new AuthService();
