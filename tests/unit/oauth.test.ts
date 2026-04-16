/**
 * Unit tests for OAuth SSO (GitHub/GitLab) — Issue #228.
 *
 * Tests cover:
 * - OAuth service: state management, profile parsing, auth flow
 * - Storage: OAuth user lookup, creation, account linking
 * - Config: enabled/disabled providers, org restrictions
 * - Integration: existing password auth unaffected
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TEST_JWT_SECRET = "test-secret-minimum-32-characters-long-xx";
const BCRYPT_ROUNDS = 4;

// Default mock config — GitHub enabled, GitLab disabled
function makeConfig(overrides: Record<string, unknown> = {}) {
  const base = {
    auth: {
      jwtSecret: TEST_JWT_SECRET,
      bcryptRounds: BCRYPT_ROUNDS,
      sessionTtlDays: 1,
      oauth: {
        github: {
          enabled: true,
          clientId: "gh-client-id",
          clientSecret: "gh-client-secret",
          allowedOrgs: [],
        },
        gitlab: {
          enabled: false,
          clientId: undefined,
          clientSecret: undefined,
          baseUrl: "https://gitlab.com",
          allowedGroups: [],
        },
        autoRegister: true,
        defaultRole: "user" as const,
      },
    },
    database: { url: undefined },
    server: { port: 5000, nodeEnv: "test" },
    providers: { anthropic: {}, google: {}, xai: {} },
  };
  return deepMerge(base, overrides);
}

// Simple deep merge for test config overrides
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

let mockConfig = makeConfig();

vi.mock("../../server/config/loader.js", () => ({
  configLoader: {
    get: () => mockConfig,
  },
}));

// Import modules after mocking
const { MemAuthStorage } = await import("../../server/auth/storage.js");
const { authService } = await import("../../server/auth/service.js");
const {
  generateState,
  validateAndConsumeState,
  isGithubEnabled,
  isGitlabEnabled,
  getEnabledProviders,
  getGithubAuthUrl,
  getGitlabAuthUrl,
  authenticateOAuth,
  OAuthError,
} = await import("../../server/auth/oauth.js");
const oauthModule = await import("../../server/auth/oauth.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

let emailCounter = 0;
function uniqueEmail(label = "oauth"): string {
  emailCounter += 1;
  return `${label}-${emailCounter}@test.com`;
}

// ─── CSRF State Tests ─────────────────────────────────────────────────────────

describe("OAuth CSRF State", () => {
  it("generates a valid UUID state", () => {
    const state = generateState();
    expect(state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("validates and consumes a valid state", () => {
    const state = generateState();
    expect(validateAndConsumeState(state)).toBe(true);
    // Second use should fail (consumed)
    expect(validateAndConsumeState(state)).toBe(false);
  });

  it("rejects an unknown state", () => {
    expect(validateAndConsumeState("nonexistent-state")).toBe(false);
  });

  it("rejects an expired state", () => {
    const state = generateState();
    // Manually expire the state by advancing time
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes > 5 min TTL
    expect(validateAndConsumeState(state)).toBe(false);
    vi.useRealTimers();
  });
});

// ─── Provider Config Tests ──────────────────────────────────────────────────

describe("OAuth Provider Config", () => {
  afterEach(() => {
    mockConfig = makeConfig();
  });

  it("reports GitHub enabled when configured", () => {
    expect(isGithubEnabled()).toBe(true);
  });

  it("reports GitHub disabled when not configured", () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: false, clientId: undefined, clientSecret: undefined, allowedOrgs: [] },
          gitlab: { enabled: false, clientId: undefined, clientSecret: undefined, baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });
    expect(isGithubEnabled()).toBe(false);
  });

  it("reports GitHub disabled when clientId missing", () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: undefined, clientSecret: "secret", allowedOrgs: [] },
          gitlab: { enabled: false, clientId: undefined, clientSecret: undefined, baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });
    expect(isGithubEnabled()).toBe(false);
  });

  it("reports GitLab disabled by default", () => {
    expect(isGitlabEnabled()).toBe(false);
  });

  it("reports GitLab enabled when fully configured", () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: [] },
          gitlab: { enabled: true, clientId: "gl-id", clientSecret: "gl-secret", baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });
    expect(isGitlabEnabled()).toBe(true);
  });

  it("lists only enabled providers", () => {
    expect(getEnabledProviders()).toEqual(["github"]);
  });

  it("returns empty when no providers enabled", () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: false, clientId: undefined, clientSecret: undefined, allowedOrgs: [] },
          gitlab: { enabled: false, clientId: undefined, clientSecret: undefined, baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });
    expect(getEnabledProviders()).toEqual([]);
  });
});

// ─── OAuth URL Generation Tests ────────────────────────────────────────────

describe("OAuth URL Generation", () => {
  afterEach(() => {
    mockConfig = makeConfig();
  });

  it("generates a correct GitHub auth URL with scopes", () => {
    const url = getGithubAuthUrl("test-state-123");
    expect(url).toContain("https://github.com/login/oauth/authorize");
    expect(url).toContain("client_id=gh-client-id");
    expect(url).toContain("state=test-state-123");
    expect(url).toContain("scope=read%3Auser+user%3Aemail+read%3Aorg");
  });

  it("generates a correct GitLab auth URL with scopes", () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: [] },
          gitlab: { enabled: true, clientId: "gl-client-id", clientSecret: "gl-secret", baseUrl: "https://gitlab.example.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });
    const url = getGitlabAuthUrl("test-state-456");
    expect(url).toContain("https://gitlab.example.com/oauth/authorize");
    expect(url).toContain("client_id=gl-client-id");
    expect(url).toContain("state=test-state-456");
    expect(url).toContain("scope=read_user");
    expect(url).toContain("response_type=code");
  });
});

// ─── MemAuthStorage OAuth Tests ────────────────────────────────────────────

describe("MemAuthStorage OAuth", () => {
  let storage: InstanceType<typeof MemAuthStorage>;

  beforeEach(() => {
    storage = new MemAuthStorage();
  });

  it("creates an OAuth user without passwordHash", async () => {
    const user = await storage.createUser({
      email: uniqueEmail(),
      name: "OAuth User",
      passwordHash: null,
      oauthProvider: "github",
      oauthId: "12345",
      avatarUrl: "https://example.com/avatar.png",
      role: "user",
    });
    expect(user.oauthProvider).toBe("github");
    expect(user.oauthId).toBe("12345");
    expect(user.avatarUrl).toBe("https://example.com/avatar.png");
  });

  it("looks up a user by OAuth provider+id", async () => {
    const email = uniqueEmail();
    await storage.createUser({
      email,
      name: "GH User",
      passwordHash: null,
      oauthProvider: "github",
      oauthId: "99999",
    });
    const found = await storage.getUserByOAuth("github", "99999");
    expect(found).toBeDefined();
    expect(found!.email).toBe(email);
  });

  it("returns undefined for non-existent OAuth lookup", async () => {
    const found = await storage.getUserByOAuth("github", "nonexistent");
    expect(found).toBeUndefined();
  });

  it("prevents duplicate OAuth provider+id", async () => {
    await storage.createUser({
      email: uniqueEmail(),
      name: "User A",
      passwordHash: null,
      oauthProvider: "github",
      oauthId: "dup-123",
    });
    await expect(
      storage.createUser({
        email: uniqueEmail(),
        name: "User B",
        passwordHash: null,
        oauthProvider: "github",
        oauthId: "dup-123",
      }),
    ).rejects.toThrow("duplicate key value violates unique constraint users_oauth_provider_id");
  });

  it("links OAuth to an existing password user", async () => {
    const email = uniqueEmail();
    const user = await storage.createUser({
      email,
      name: "Password User",
      passwordHash: "hashed-pw",
    });
    expect(user.oauthProvider).toBeNull();

    const linked = await storage.linkOAuth(user.id, "github", "link-456", "https://avatar.url");
    expect(linked.oauthProvider).toBe("github");
    expect(linked.oauthId).toBe("link-456");
    expect(linked.avatarUrl).toBe("https://avatar.url");

    // Should be findable by OAuth lookup
    const found = await storage.getUserByOAuth("github", "link-456");
    expect(found).toBeDefined();
    expect(found!.id).toBe(user.id);
  });

  it("password hash is null for OAuth-only users", async () => {
    const email = uniqueEmail();
    await storage.createUser({
      email,
      name: "OAuth Only",
      passwordHash: null,
      oauthProvider: "github",
      oauthId: "nopw-789",
    });
    const hash = await storage.getPasswordHashByEmail(email);
    expect(hash).toBeUndefined();
  });

  it("returns OAuth fields in toUser", async () => {
    const user = await storage.createUser({
      email: uniqueEmail(),
      name: "Full Profile",
      passwordHash: null,
      oauthProvider: "gitlab",
      oauthId: "gl-111",
      avatarUrl: "https://gitlab.com/avatar.png",
    });
    expect(user).toHaveProperty("oauthProvider", "gitlab");
    expect(user).toHaveProperty("oauthId", "gl-111");
    expect(user).toHaveProperty("avatarUrl", "https://gitlab.com/avatar.png");
  });
});

// ─── authenticateOAuth Tests ──────────────────────────────────────────────

describe("authenticateOAuth", () => {
  afterEach(() => {
    mockConfig = makeConfig();
  });

  it("auto-registers a new OAuth user", async () => {
    const email = uniqueEmail("autoregister");
    const profile = {
      provider: "github" as const,
      id: `auto-${Date.now()}`,
      email,
      name: "Auto User",
      avatarUrl: "https://avatar.test/a.png",
      orgs: [],
    };

    const session = await authenticateOAuth(profile);
    expect(session.token).toBeDefined();
    expect(session.user.email).toBe(email);
    expect(session.user.role).toBe("user");
    expect(session.user.oauthProvider).toBe("github");
  });

  it("logs in an existing OAuth user", async () => {
    const email = uniqueEmail("existing-oauth");
    const oauthId = `existing-${Date.now()}`;
    const profile = {
      provider: "github" as const,
      id: oauthId,
      email,
      name: "Existing OAuth",
      avatarUrl: null,
      orgs: [],
    };

    // First call auto-registers
    const session1 = await authenticateOAuth(profile);
    // Second call logs in
    const session2 = await authenticateOAuth(profile);

    expect(session2.user.id).toBe(session1.user.id);
    expect(session2.token).not.toBe(session1.token);
  });

  it("links OAuth to an existing email user", async () => {
    // First create a password user via the auth service
    const email = uniqueEmail("link-email");

    // We need to create the first admin to close registration, then test linking
    // Use storage directly since authService.register() has the one-user restriction
    const { MemAuthStorage } = await import("../../server/auth/storage.js");
    // Actually, authenticateOAuth uses the singleton authStorage, so we need to use it
    // We'll create a user that has the same email via authenticateOAuth first with a different provider
    // Actually the simpler approach: create via storage then test linking

    // Import the real storage singleton
    const { authStorage } = await import("../../server/auth/storage.js");
    const user = await authStorage.createUser({
      email,
      name: "Password User",
      passwordHash: "hashed-password",
    });

    // Now OAuth login with the same email should link
    const profile = {
      provider: "github" as const,
      id: `link-${Date.now()}`,
      email,
      name: "Updated Name",
      avatarUrl: "https://linked.avatar/a.png",
      orgs: [],
    };

    const session = await authenticateOAuth(profile);
    expect(session.user.id).toBe(user.id);
    expect(session.user.oauthProvider).toBe("github");
  });

  it("rejects when auto-register is disabled and user not found", async () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: [] },
          gitlab: { enabled: false, clientId: undefined, clientSecret: undefined, baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: false,
          defaultRole: "user",
        },
      },
    });

    const profile = {
      provider: "github" as const,
      id: `noreg-${Date.now()}`,
      email: uniqueEmail("noreg"),
      name: "No Register",
      avatarUrl: null,
      orgs: [],
    };

    await expect(authenticateOAuth(profile)).rejects.toThrow("Automatic registration is disabled");
  });

  it("rejects when org restriction not met", async () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: ["acme-corp"] },
          gitlab: { enabled: false, clientId: undefined, clientSecret: undefined, baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });

    const profile = {
      provider: "github" as const,
      id: `orgdeny-${Date.now()}`,
      email: uniqueEmail("orgdeny"),
      name: "Wrong Org",
      avatarUrl: null,
      orgs: ["other-org"],
    };

    await expect(authenticateOAuth(profile)).rejects.toThrow("Your organization is not allowed");
  });

  it("allows when user belongs to an allowed org", async () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: ["acme-corp"] },
          gitlab: { enabled: false, clientId: undefined, clientSecret: undefined, baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });

    const profile = {
      provider: "github" as const,
      id: `orgallow-${Date.now()}`,
      email: uniqueEmail("orgallow"),
      name: "Right Org",
      avatarUrl: null,
      orgs: ["acme-corp", "other"],
    };

    const session = await authenticateOAuth(profile);
    expect(session.user.email).toBe(profile.email);
  });

  it("rejects disabled OAuth user", async () => {
    const email = uniqueEmail("disabled");
    const oauthId = `disabled-${Date.now()}`;

    // Create user first
    const profile = {
      provider: "github" as const,
      id: oauthId,
      email,
      name: "Will Be Disabled",
      avatarUrl: null,
      orgs: [],
    };
    const session = await authenticateOAuth(profile);

    // Deactivate user
    const { authStorage } = await import("../../server/auth/storage.js");
    await authStorage.deactivateUser(session.user.id);

    // Attempt login again
    await expect(authenticateOAuth(profile)).rejects.toThrow("Account is disabled");
  });

  it("uses configured defaultRole for new OAuth users", async () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: [] },
          gitlab: { enabled: false, clientId: undefined, clientSecret: undefined, baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "maintainer",
        },
      },
    });

    const profile = {
      provider: "github" as const,
      id: `role-${Date.now()}`,
      email: uniqueEmail("defaultrole"),
      name: "Maintainer User",
      avatarUrl: null,
      orgs: [],
    };

    const session = await authenticateOAuth(profile);
    expect(session.user.role).toBe("maintainer");
  });
});

// ─── OAuthError Tests ─────────────────────────────────────────────────────

describe("OAuthError", () => {
  it("has correct name and code", () => {
    const err = new OAuthError("ORG_DENIED", "Not allowed");
    expect(err.name).toBe("OAuthError");
    expect(err.code).toBe("ORG_DENIED");
    expect(err.message).toBe("Not allowed");
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── Password Auth Regression Tests ─────────────────────────────────────────

describe("Password auth unchanged with OAuth", () => {
  afterEach(() => {
    mockConfig = makeConfig();
  });

  it("password login still works for password users (via AuthService)", async () => {
    // authService.register only works for the first user. Since other tests
    // may have created users, we test via storage + service.login
    const { authStorage } = await import("../../server/auth/storage.js");
    const bcrypt = await import("bcryptjs");
    const email = uniqueEmail("pwlogin");
    const hash = await bcrypt.default.hash("testpassword", BCRYPT_ROUNDS);

    await authStorage.createUser({
      email,
      name: "PW User",
      passwordHash: hash,
      role: "user",
    });

    const session = await authService.login(email, "testpassword");
    expect(session.token).toBeDefined();
    expect(session.user.email).toBe(email);
  });

  it("OAuth user cannot login with password (no passwordHash)", async () => {
    const email = uniqueEmail("nopwlogin");
    const profile = {
      provider: "github" as const,
      id: `nopw-${Date.now()}`,
      email,
      name: "OAuth Only",
      avatarUrl: null,
      orgs: [],
    };

    await authenticateOAuth(profile);

    // Try password login — should fail because passwordHash is null
    await expect(authService.login(email, "anypassword")).rejects.toThrow("Invalid credentials");
  });

  it("validateToken works for both password and OAuth sessions", async () => {
    const email = uniqueEmail("validate");
    const profile = {
      provider: "github" as const,
      id: `val-${Date.now()}`,
      email,
      name: "Validate User",
      avatarUrl: null,
      orgs: [],
    };

    const session = await authenticateOAuth(profile);
    const user = await authService.validateToken(session.token);
    expect(user).not.toBeNull();
    expect(user!.email).toBe(email);
  });
});

// ─── GitLab Group Restriction Tests ───────────────────────────────────────

describe("GitLab group restrictions", () => {
  afterEach(() => {
    mockConfig = makeConfig();
  });

  it("allows when no group restriction set", async () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: [] },
          gitlab: { enabled: true, clientId: "gl-id", clientSecret: "gl-secret", baseUrl: "https://gitlab.com", allowedGroups: [] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });

    const profile = {
      provider: "gitlab" as const,
      id: `gl-nogroup-${Date.now()}`,
      email: uniqueEmail("gl-nogroup"),
      name: "GL No Group",
      avatarUrl: null,
      orgs: [],
    };

    const session = await authenticateOAuth(profile);
    expect(session.user.oauthProvider).toBe("gitlab");
  });

  it("rejects when user not in allowed group", async () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: [] },
          gitlab: { enabled: true, clientId: "gl-id", clientSecret: "gl-secret", baseUrl: "https://gitlab.com", allowedGroups: ["my-company"] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });

    const profile = {
      provider: "gitlab" as const,
      id: `gl-wronggroup-${Date.now()}`,
      email: uniqueEmail("gl-wronggroup"),
      name: "GL Wrong Group",
      avatarUrl: null,
      orgs: ["other-group"],
    };

    await expect(authenticateOAuth(profile)).rejects.toThrow("Your organization is not allowed");
  });

  it("allows when user in allowed group", async () => {
    mockConfig = makeConfig({
      auth: {
        jwtSecret: TEST_JWT_SECRET,
        bcryptRounds: BCRYPT_ROUNDS,
        sessionTtlDays: 1,
        oauth: {
          github: { enabled: true, clientId: "gh-client-id", clientSecret: "gh-client-secret", allowedOrgs: [] },
          gitlab: { enabled: true, clientId: "gl-id", clientSecret: "gl-secret", baseUrl: "https://gitlab.com", allowedGroups: ["my-company"] },
          autoRegister: true,
          defaultRole: "user",
        },
      },
    });

    const profile = {
      provider: "gitlab" as const,
      id: `gl-rightgroup-${Date.now()}`,
      email: uniqueEmail("gl-rightgroup"),
      name: "GL Right Group",
      avatarUrl: null,
      orgs: ["my-company"],
    };

    const session = await authenticateOAuth(profile);
    expect(session.user.oauthProvider).toBe("gitlab");
  });
});
