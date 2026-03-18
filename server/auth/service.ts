import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { User, AuthSession, UserRole } from "@shared/types";
import { configLoader } from "../config/loader";
import { authStorage } from "./storage";

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

    // First user is always admin
    const user = await authStorage.createUser({ email, name, passwordHash, role: "admin" });

    return this.buildSession(user);
  }

  async login(email: string, password: string): Promise<AuthSession> {
    const user = await authStorage.getUserByEmail(email);
    if (!user) {
      throw new Error("Invalid credentials");
    }

    const passwordHash = await authStorage.getPasswordHashByEmail(email);
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

    // Update last_login_at
    const updatedUser = await authStorage.updateUser(user.id, { lastLoginAt: new Date() });
    return this.buildSession(updatedUser);
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

  async getUserById(id: string): Promise<User | null> {
    return (await authStorage.getUserById(id)) ?? null;
  }

  async getAllUsers(): Promise<User[]> {
    return authStorage.getAllUsers();
  }

  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const user = await authStorage.getUserById(userId);
    if (!user) return false;
    const hash = await authStorage.getPasswordHashByEmail(user.email);
    if (!hash) return false;
    return bcrypt.compare(password, hash);
  }

  async updateUser(
    id: string,
    updates: { name?: string; email?: string; password?: string },
  ): Promise<User> {
    const setValues: { name?: string; email?: string; passwordHash?: string } = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.email !== undefined) setValues.email = updates.email;
    if (updates.password !== undefined) {
      const { bcryptRounds } = configLoader.get().auth;
      setValues.passwordHash = await bcrypt.hash(updates.password, bcryptRounds);
    }
    return authStorage.updateUser(id, setValues);
  }

  async updateUserRole(id: string, role: UserRole): Promise<User> {
    return authStorage.updateUserRole(id, role);
  }

  async deactivateUser(id: string): Promise<User> {
    return authStorage.deactivateUser(id);
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
