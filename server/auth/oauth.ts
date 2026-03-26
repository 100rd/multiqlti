import type { User, AuthSession, OAuthProvider, UserRole } from "@shared/types";
import { configLoader } from "../config/loader";
import { authStorage } from "./storage";
import { authService } from "./service";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OAuthProfile {
  provider: OAuthProvider;
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  orgs: string[];
}

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

interface GitHubOrg {
  login: string;
}

interface GitLabUser {
  id: number;
  username: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

interface GitLabGroup {
  full_path: string;
}

// ─── CSRF State Store ──────────────────────────────────────────────────────

const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface StateEntry {
  createdAt: number;
}

const pendingStates = new Map<string, StateEntry>();

function cleanExpiredStates(): void {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}

export function generateState(): string {
  cleanExpiredStates();
  const state = crypto.randomUUID();
  pendingStates.set(state, { createdAt: Date.now() });
  return state;
}

export function validateAndConsumeState(state: string): boolean {
  cleanExpiredStates();
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state);
  return true;
}

// ─── Provider Config Helpers ──────────────────────────────────────────────

export function isGithubEnabled(): boolean {
  const { oauth } = configLoader.get().auth;
  return oauth.github.enabled && !!oauth.github.clientId && !!oauth.github.clientSecret;
}

export function isGitlabEnabled(): boolean {
  const { oauth } = configLoader.get().auth;
  return oauth.gitlab.enabled && !!oauth.gitlab.clientId && !!oauth.gitlab.clientSecret;
}

export function getEnabledProviders(): OAuthProvider[] {
  const providers: OAuthProvider[] = [];
  if (isGithubEnabled()) providers.push("github");
  if (isGitlabEnabled()) providers.push("gitlab");
  return providers;
}

// ─── GitHub OAuth ──────────────────────────────────────────────────────────

export function getGithubAuthUrl(state: string): string {
  const { clientId } = configLoader.get().auth.oauth.github;
  const params = new URLSearchParams({
    client_id: clientId!,
    state,
    scope: "read:user user:email read:org",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function exchangeGithubCode(code: string): Promise<string> {
  const { clientId, clientSecret } = configLoader.get().auth.oauth.github;
  const resp = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });
  if (!resp.ok) {
    throw new Error(`GitHub token exchange failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new Error(`GitHub token exchange error: ${data.error ?? "no access_token"}`);
  }
  return data.access_token;
}

async function fetchGithubUser(accessToken: string): Promise<GitHubUser> {
  const resp = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`GitHub user fetch failed: ${resp.status}`);
  return resp.json() as Promise<GitHubUser>;
}

async function fetchGithubEmail(accessToken: string): Promise<string> {
  const resp = await fetch("https://api.github.com/user/emails", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`GitHub emails fetch failed: ${resp.status}`);
  const emails = (await resp.json()) as GitHubEmail[];
  const primary = emails.find((e) => e.primary && e.verified);
  if (!primary) throw new Error("No verified primary email on GitHub account");
  return primary.email;
}

async function fetchGithubOrgs(accessToken: string): Promise<string[]> {
  const resp = await fetch("https://api.github.com/user/orgs", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) return [];
  const orgs = (await resp.json()) as GitHubOrg[];
  return orgs.map((o) => o.login);
}

export async function getGithubProfile(code: string): Promise<OAuthProfile> {
  const accessToken = await exchangeGithubCode(code);
  const [ghUser, orgs] = await Promise.all([
    fetchGithubUser(accessToken),
    fetchGithubOrgs(accessToken),
  ]);
  const email = ghUser.email ?? (await fetchGithubEmail(accessToken));
  return {
    provider: "github",
    id: String(ghUser.id),
    email,
    name: ghUser.name ?? ghUser.login,
    avatarUrl: ghUser.avatar_url ?? null,
    orgs,
  };
}

// ─── GitLab OAuth ──────────────────────────────────────────────────────────

export function getGitlabAuthUrl(state: string): string {
  const { clientId, baseUrl } = configLoader.get().auth.oauth.gitlab;
  const params = new URLSearchParams({
    client_id: clientId!,
    redirect_uri: getGitlabCallbackUrl(),
    response_type: "code",
    state,
    scope: "read_user",
  });
  return `${baseUrl}/oauth/authorize?${params.toString()}`;
}

function getGitlabCallbackUrl(): string {
  // The callback URL must match what is registered in GitLab
  // We build it from the server port; in production, a reverse proxy handles host.
  const port = configLoader.get().server.port;
  return `http://localhost:${port}/api/auth/oauth/gitlab/callback`;
}

async function exchangeGitlabCode(code: string): Promise<string> {
  const { clientId, clientSecret, baseUrl } = configLoader.get().auth.oauth.gitlab;
  const resp = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: getGitlabCallbackUrl(),
    }),
  });
  if (!resp.ok) throw new Error(`GitLab token exchange failed: ${resp.status}`);
  const data = (await resp.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token) {
    throw new Error(`GitLab token exchange error: ${data.error ?? "no access_token"}`);
  }
  return data.access_token;
}

async function fetchGitlabUser(accessToken: string, baseUrl: string): Promise<GitLabUser> {
  const resp = await fetch(`${baseUrl}/api/v4/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`GitLab user fetch failed: ${resp.status}`);
  return resp.json() as Promise<GitLabUser>;
}

async function fetchGitlabGroups(accessToken: string, baseUrl: string): Promise<string[]> {
  const resp = await fetch(`${baseUrl}/api/v4/groups?min_access_level=10`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) return [];
  const groups = (await resp.json()) as GitLabGroup[];
  return groups.map((g) => g.full_path);
}

export async function getGitlabProfile(code: string): Promise<OAuthProfile> {
  const { baseUrl } = configLoader.get().auth.oauth.gitlab;
  const accessToken = await exchangeGitlabCode(code);
  const [glUser, groups] = await Promise.all([
    fetchGitlabUser(accessToken, baseUrl),
    fetchGitlabGroups(accessToken, baseUrl),
  ]);
  return {
    provider: "gitlab",
    id: String(glUser.id),
    email: glUser.email,
    name: glUser.name ?? glUser.username,
    avatarUrl: glUser.avatar_url ?? null,
    orgs: groups,
  };
}

// ─── Org/Group Restriction Check ──────────────────────────────────────────

function checkOrgRestriction(profile: OAuthProfile): boolean {
  const { oauth } = configLoader.get().auth;
  if (profile.provider === "github") {
    const { allowedOrgs } = oauth.github;
    if (allowedOrgs.length === 0) return true;
    return profile.orgs.some((org) => allowedOrgs.includes(org));
  }
  if (profile.provider === "gitlab") {
    const { allowedGroups } = oauth.gitlab;
    if (allowedGroups.length === 0) return true;
    return profile.orgs.some((group) => allowedGroups.includes(group));
  }
  return false;
}

// ─── Authenticate OAuth ──────────────────────────────────────────────────

/**
 * Authenticate a user from an OAuth profile. Handles:
 * 1. Existing OAuth user (lookup by provider+id) -> update profile, login
 * 2. Existing email user (link accounts) -> link OAuth, login
 * 3. New user (auto-register if enabled) -> create user, login
 *
 * Returns an AuthSession (JWT) on success, or throws an error.
 */
export async function authenticateOAuth(profile: OAuthProfile): Promise<AuthSession> {
  // Enforce org/group restrictions
  if (!checkOrgRestriction(profile)) {
    throw new OAuthError("ORG_DENIED", "Your organization is not allowed to access this instance");
  }

  // 1. Look up by OAuth provider + ID
  const existingOAuth = await authStorage.getUserByOAuth(profile.provider, profile.id);
  if (existingOAuth) {
    return loginExistingOAuthUser(existingOAuth, profile);
  }

  // 2. Look up by email — link accounts if email matches
  const existingEmail = await authStorage.getUserByEmail(profile.email);
  if (existingEmail) {
    return linkAndLogin(existingEmail, profile);
  }

  // 3. Auto-register if allowed
  return autoRegisterOAuthUser(profile);
}

async function loginExistingOAuthUser(user: User, profile: OAuthProfile): Promise<AuthSession> {
  if (!user.isActive) {
    throw new OAuthError("ACCOUNT_DISABLED", "Account is disabled");
  }
  // Update profile fields (name, avatar may change)
  const updated = await authStorage.updateUser(user.id, {
    name: profile.name,
    avatarUrl: profile.avatarUrl ?? undefined,
    lastLoginAt: new Date(),
  });
  return authService.buildSession(updated);
}

async function linkAndLogin(user: User, profile: OAuthProfile): Promise<AuthSession> {
  if (!user.isActive) {
    throw new OAuthError("ACCOUNT_DISABLED", "Account is disabled");
  }
  const linked = await authStorage.linkOAuth(
    user.id,
    profile.provider,
    profile.id,
    profile.avatarUrl ?? undefined,
  );
  const updated = await authStorage.updateUser(linked.id, { lastLoginAt: new Date() });
  return authService.buildSession(updated);
}

async function autoRegisterOAuthUser(profile: OAuthProfile): Promise<AuthSession> {
  const { oauth } = configLoader.get().auth;
  if (!oauth.autoRegister) {
    throw new OAuthError("REGISTRATION_DISABLED", "Automatic registration is disabled");
  }

  const role: UserRole = oauth.defaultRole;
  const user = await authStorage.createUser({
    email: profile.email,
    name: profile.name,
    passwordHash: null,
    oauthProvider: profile.provider,
    oauthId: profile.id,
    avatarUrl: profile.avatarUrl,
    role,
  });

  return authService.buildSession(user);
}

// ─── Error Class ──────────────────────────────────────────────────────────

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}
