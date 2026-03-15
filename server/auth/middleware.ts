import type { Request, Response, NextFunction } from "express";
import { authService } from "./service";
import type { User } from "@shared/types";

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
  createdAt: new Date(0),
};

function isTestBypassEnabled(): boolean {
  return process.env.NODE_ENV === "test" && process.env.DISABLE_AUTH === "true";
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
