import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { User, AuthSession } from "@shared/types";
import type { InsertUser } from "@shared/schema";
import { configLoader } from "../config/loader";
import { authStorage, MemAuthStorage } from "./storage";

interface JwtPayload {
  userId: string;
  sessionId: string;
}

class AuthService {
  async hasUsers(): Promise<boolean> {
    return authStorage.hasUsers();
  }

  async register(email: string, name: string, password: string): Promise<AuthSession> {
    const alreadyHasUsers = await authStorage.hasUsers();
    if (alreadyHasUsers) {
      const err = new Error("Registration is closed — admin account already exists");
      (err as NodeJS.ErrnoException).code = "REGISTRATION_CLOSED";
      throw err;
    }

    const { bcryptRounds } = configLoader.get().auth;
    const passwordHash = await bcrypt.hash(password, bcryptRounds);

    const userData: InsertUser = { email, name, passwordHash };
    const user = await authStorage.createUser(userData);

    return this.buildSession(user);
  }

  async login(email: string, password: string): Promise<AuthSession> {
    const user = await authStorage.getUserByEmail(email);
    if (!user) {
      throw new Error("Invalid credentials");
    }

    const passwordHash = await this.getPasswordHash(email);
    if (!passwordHash) {
      throw new Error("Invalid credentials");
    }

    const valid = await bcrypt.compare(password, passwordHash);
    if (!valid) {
      throw new Error("Invalid credentials");
    }

    if (!user.isActive) {
      throw new Error("Account is disabled");
    }

    return this.buildSession(user);
  }

  async logout(token: string): Promise<void> {
    await authStorage.deleteSession(token);
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

    const session = await authStorage.getSession(token);
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      await authStorage.deleteSessionById(session.id);
      return null;
    }
    if (session.userId !== payload.userId) return null;

    const user = await authStorage.getUserById(payload.userId);
    if (!user || !user.isActive) return null;

    return user;
  }

  private async getPasswordHash(email: string): Promise<string | undefined> {
    if (authStorage instanceof MemAuthStorage) {
      const user = await authStorage.getUserByEmail(email);
      if (!user) return undefined;
      return authStorage.getPasswordHash(user.id);
    }
    // PgAuthStorage: fetch password hash directly
    const { PgAuthStorage } = await import("./storage");
    if (authStorage instanceof PgAuthStorage) {
      return authStorage.getPasswordHashFromDb(email);
    }
    return undefined;
  }

  private async buildSession(user: User): Promise<AuthSession> {
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

    await authStorage.createSession(sessionId, user.id, token, expiresAt);

    return { token, user, expiresAt };
  }
}

export const authService = new AuthService();
