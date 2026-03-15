import type { Express } from "express";
import { z } from "zod";
import { authService } from "../auth/service";
import { requireAuth } from "../auth/middleware";

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function registerAuthRoutes(app: Express): void {
  // Public: check whether any users exist
  app.get("/api/auth/status", async (_req, res) => {
    const hasUsers = await authService.hasUsers();
    res.json({ hasUsers });
  });

  // Public: register first admin user
  app.post("/api/auth/register", async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }

    const { email, name, password } = parsed.data;

    try {
      const session = await authService.register(email, name, password);
      res.status(201).json(session);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "REGISTRATION_CLOSED") {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error.message?.includes("unique") || error.message?.includes("duplicate")) {
        res.status(409).json({ error: "Email already registered" });
        return;
      }
      throw err;
    }
  });

  // Public: login
  app.post("/api/auth/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }

    const { email, password } = parsed.data;

    try {
      const session = await authService.login(email, password);
      res.json(session);
    } catch {
      res.status(401).json({ error: "Invalid credentials" });
    }
  });

  // Protected: logout
  app.post("/api/auth/logout", requireAuth, async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    const cookieHeader = req.headers.cookie;
    const cookieToken = cookieHeader?.match(/(?:^|;\s*)auth_token=([^;]+)/)?.[1];

    const activeToken = token ?? (cookieToken ? decodeURIComponent(cookieToken) : null);
    if (activeToken) {
      await authService.logout(activeToken);
    }

    res.status(204).send();
  });

  // Protected: get current user
  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
  });
}
