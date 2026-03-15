import type { Request, Response, NextFunction } from "express";
import { authService } from "./service";
import type { User, UserRole } from "@shared/types";
import { configLoader } from "../config/loader";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** Synthetic user injected when DISABLE_AUTH=true (test mode only). */
const TEST_USER: User = {
  id: "test-user-id",
  email: "test@example.com",
  name: "Test User",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

function isTestBypassEnabled(): boolean {
  // DISABLE_AUTH is a raw test-runner escape hatch; intentionally not in the typed config.
  return configLoader.get().server.nodeEnv === "test" && process.env.DISABLE_AUTH === "true";
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }

  return null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isTestBypassEnabled()) {
    req.user = TEST_USER;
    next();
    return;
  }

  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = await authService.validateToken(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.user = user;
  next();
}

/**
 * Middleware factory that checks if the authenticated user has one of the
 * specified roles. Must be used after requireAuth.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!roles.includes(user.role)) {
      res.status(403).json({ error: "Forbidden — insufficient role" });
      return;
    }

    next();
  };
}

/**
 * Middleware factory that allows access if the authenticated user is the
 * resource owner OR has one of the specified roles.
 *
 * @param getOwnerId - A function that extracts the owner ID from the request.
 *   Called lazily so you can look it up from DB before this middleware runs
 *   and pass a resolved value, or provide a getter over req state.
 */
export function requireOwnerOrRole(
  getOwnerId: (req: Request) => string | null | undefined,
  ...roles: UserRole[]
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const ownerId = getOwnerId(req);

    // Allow if user owns the resource
    if (ownerId && ownerId === user.id) {
      next();
      return;
    }

    // Allow if user has a qualifying role
    if (roles.includes(user.role)) {
      next();
      return;
    }

    res.status(403).json({ error: "Forbidden — must be owner or have required role" });
  };
}
