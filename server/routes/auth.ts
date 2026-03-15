import type { Express } from "express";
import { z } from "zod";
import { authService } from "../auth/service";
import { requireAuth, requireRole } from "../auth/middleware";
import { USER_ROLES } from "@shared/schema";

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const updateMeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
});

const updateRoleSchema = z.object({
  role: z.enum(USER_ROLES),
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

  // Protected: get current user (includes role)
  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // Protected: update own profile (name, email, password)
  app.put("/api/auth/me", requireAuth, async (req, res) => {
    const parsed = updateMeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const updated = await authService.updateUser(req.user.id, parsed.data);
      res.json({ user: updated });
    } catch (err) {
      const error = err as Error;
      if (error.message?.includes("unique") || error.message?.includes("duplicate")) {
        res.status(409).json({ error: "Email already in use" });
        return;
      }
      throw err;
    }
  });

  // Admin: list all users
  app.get("/api/users", requireAuth, requireRole("admin"), async (_req, res) => {
    const users = await authService.getAllUsers();
    res.json(users);
  });

  // Admin: change a user's role
  app.put("/api/users/:id/role", requireAuth, requireRole("admin"), async (req, res) => {
    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }

    // Prevent admin from demoting themselves
    if (req.user?.id === req.params["id"] as string && parsed.data.role !== "admin") {
      res.status(400).json({ error: "Cannot change your own role" });
      return;
    }

    try {
      const updated = await authService.updateUserRole(req.params["id"] as string, parsed.data.role);
      res.json({ user: updated });
    } catch (err) {
      const error = err as Error;
      if (error.message === "User not found") {
        res.status(404).json({ error: "User not found" });
        return;
      }
      throw err;
    }
  });

  // Admin: deactivate a user (soft delete — sets is_active=false)
  app.delete("/api/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
    // Prevent admin from deactivating themselves
    if (req.user?.id === req.params["id"] as string) {
      res.status(400).json({ error: "Cannot deactivate your own account" });
      return;
    }

    try {
      await authService.deactivateUser(req.params["id"] as string);
      res.status(204).send();
    } catch (err) {
      const error = err as Error;
      if (error.message === "User not found") {
        res.status(404).json({ error: "User not found" });
        return;
      }
      throw err;
    }
  });
}
