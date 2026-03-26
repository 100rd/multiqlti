import type { Express } from "express";
import { z } from "zod";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { authService } from "../auth/service";
import { requireAuth, requireRole } from "../auth/middleware";
import { USER_ROLES } from "@shared/schema";
import {
  isGithubEnabled,
  isGitlabEnabled,
  getEnabledProviders,
  generateState,
  validateAndConsumeState,
  getGithubAuthUrl,
  getGitlabAuthUrl,
  getGithubProfile,
  getGitlabProfile,
  authenticateOAuth,
  OAuthError,
} from "../auth/oauth";

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Too many login attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
});

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
  currentPassword: z.string().optional(),
});

const updateRoleSchema = z.object({
  role: z.enum(USER_ROLES),
});

const adminUpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  role: z.enum(USER_ROLES).optional(),
  isActive: z.boolean().optional(),
});

const oauthCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
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

  // Public: login (rate-limited)
  app.post("/api/auth/login", loginLimiter, async (req, res) => {
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

    // Verify current password before allowing a password change
    if (parsed.data.password) {
      if (!parsed.data.currentPassword) {
        res.status(400).json({ error: "Current password is required to set a new password" });
        return;
      }
      const valid = await authService.verifyPassword(req.user.id, parsed.data.currentPassword);
      if (!valid) {
        res.status(403).json({ error: "Current password is incorrect" });
        return;
      }
    }

    try {
      const { currentPassword: _cp, ...updates } = parsed.data;
      const updated = await authService.updateUser(req.user.id, updates);
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

  // Admin: update a user (name, email, role, isActive)
  app.patch("/api/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
    const parsed = adminUpdateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      return;
    }

    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    // Prevent admin from changing their own role
    if (req.user?.id === req.params["id"] && updates.role && updates.role !== "admin") {
      res.status(400).json({ error: "Cannot change your own role" });
      return;
    }

    try {
      const userId = req.params["id"] as string;
      let updated;

      // Apply profile updates (name, email)
      if (updates.name !== undefined || updates.email !== undefined) {
        updated = await authService.updateUser(userId, {
          name: updates.name,
          email: updates.email,
        });
      }

      // Apply role change
      if (updates.role !== undefined) {
        updated = await authService.updateUserRole(userId, updates.role);
      }

      // Apply active status change
      if (updates.isActive === false) {
        updated = await authService.deactivateUser(userId);
      }

      if (!updated) {
        // Fetch current state if no mutations were applied
        const users = await authService.getAllUsers();
        updated = users.find((u) => u.id === userId);
        if (!updated) {
          res.status(404).json({ error: "User not found" });
          return;
        }
      }

      res.json({ user: updated });
    } catch (err) {
      const error = err as Error;
      if (error.message === "User not found") {
        res.status(404).json({ error: "User not found" });
        return;
      }
      if (error.message?.includes("unique") || error.message?.includes("duplicate")) {
        res.status(409).json({ error: "Email already in use" });
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

  // ─── OAuth Routes ──────────────────────────────────────────────────────────

  // Public: list enabled OAuth providers
  app.get("/api/auth/oauth/providers", (_req, res) => {
    res.json({ providers: getEnabledProviders() });
  });

  // Public: initiate GitHub OAuth flow
  app.get("/api/auth/oauth/github", (_req, res) => {
    if (!isGithubEnabled()) {
      res.status(404).json({ error: "GitHub OAuth is not configured" });
      return;
    }
    const state = generateState();
    const url = getGithubAuthUrl(state);
    res.redirect(url);
  });

  // Public: GitHub OAuth callback
  app.get("/api/auth/oauth/github/callback", async (req, res) => {
    if (!isGithubEnabled()) {
      res.status(404).json({ error: "GitHub OAuth is not configured" });
      return;
    }

    const parsed = oauthCallbackSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid code/state parameters" });
      return;
    }

    const { code, state } = parsed.data;

    if (!validateAndConsumeState(state)) {
      res.status(400).json({ error: "Invalid or expired state parameter" });
      return;
    }

    try {
      const profile = await getGithubProfile(code);
      const session = await authenticateOAuth(profile);
      redirectWithToken(res, session.token);
    } catch (err) {
      handleOAuthError(res, err);
    }
  });

  // Public: initiate GitLab OAuth flow
  app.get("/api/auth/oauth/gitlab", (_req, res) => {
    if (!isGitlabEnabled()) {
      res.status(404).json({ error: "GitLab OAuth is not configured" });
      return;
    }
    const state = generateState();
    const url = getGitlabAuthUrl(state);
    res.redirect(url);
  });

  // Public: GitLab OAuth callback
  app.get("/api/auth/oauth/gitlab/callback", async (req, res) => {
    if (!isGitlabEnabled()) {
      res.status(404).json({ error: "GitLab OAuth is not configured" });
      return;
    }

    const parsed = oauthCallbackSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid code/state parameters" });
      return;
    }

    const { code, state } = parsed.data;

    if (!validateAndConsumeState(state)) {
      res.status(400).json({ error: "Invalid or expired state parameter" });
      return;
    }

    try {
      const profile = await getGitlabProfile(code);
      const session = await authenticateOAuth(profile);
      redirectWithToken(res, session.token);
    } catch (err) {
      handleOAuthError(res, err);
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function redirectWithToken(res: { redirect(url: string): void }, token: string): void {
  // Use URL fragment (#) not query param (?) — fragments are never sent in Referer headers,
  // not logged by proxies, and not stored in server access logs.
  res.redirect(`/#token=${encodeURIComponent(token)}`);
}

function handleOAuthError(
  res: { status(code: number): { json(body: unknown): void } },
  err: unknown,
): void {
  if (err instanceof OAuthError) {
    const statusMap: Record<string, number> = {
      ORG_DENIED: 403,
      ACCOUNT_DISABLED: 403,
      REGISTRATION_DISABLED: 403,
    };
    const status = statusMap[err.code] ?? 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  // Log unexpected errors but don't leak details
  console.error("[oauth] Unexpected error:", err);
  res.status(500).json({ error: "OAuth authentication failed" });
}
