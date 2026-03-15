import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db";
import { users, sessions } from "@shared/schema";
import { eq, count } from "drizzle-orm";
import type { User, AuthSession } from "@shared/types";

const SALT_ROUNDS = 12;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is required");
  }
  return secret;
}

interface JwtPayload {
  userId: string;
  sessionId: string;
}

function rowToUser(row: { id: string; email: string; name: string; isActive: boolean; createdAt: Date }): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

class AuthService {
  async hasUsers(): Promise<boolean> {
    const result = await db.select({ total: count() }).from(users);
    return (result[0]?.total ?? 0) > 0;
  }

  async register(email: string, name: string, password: string): Promise<AuthSession> {
    const alreadyHasUsers = await this.hasUsers();
    if (alreadyHasUsers) {
      const err = new Error("Registration is closed — admin account already exists");
      (err as NodeJS.ErrnoException).code = "REGISTRATION_CLOSED";
      throw err;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const [user] = await db.insert(users).values({ email, name, passwordHash }).returning();

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

    return this.createSession(user);
  }

  async logout(token: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.token, token));
  }

  async validateToken(token: string): Promise<User | null> {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, getJwtSecret()) as JwtPayload;
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

  private async createSession(user: { id: string; email: string; name: string; isActive: boolean; createdAt: Date }): Promise<AuthSession> {
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    const sessionId = crypto.randomUUID();

    const token = jwt.sign(
      { userId: user.id, sessionId } satisfies JwtPayload,
      getJwtSecret(),
      { expiresIn: "7d" },
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
