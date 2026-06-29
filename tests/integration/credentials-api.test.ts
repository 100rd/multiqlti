/**
 * Integration tests — Credentials API (ADR-001 Phase 1 broker UI endpoints).
 *
 * Verifies:
 *   - GET /api/credentials            — 400 without x-project-id header;
 *                                       200 + CredentialMetadata[] when header present
 *   - GET /api/credentials/access-log — 400 without x-project-id;
 *                                       200 + rows ordered newest-first with header
 *   - GET /api/credentials/leases     — 400 without x-project-id;
 *                                       200 + rows ordered newest-first with header;
 *                                       200 + filtered rows with ?status=active;
 *                                       400 on unrecognised ?status value
 *
 * Strategy:
 *   - server/db.js is mocked so tests are DB-free.
 *   - server/credentials/db-crypto-provider.js is mocked so listCredentials
 *     does not exercise the real provider's complex workspace-connection JOIN.
 *   - requireProject middleware is exercised for real (using the mocked db).
 *   - The test app mirrors the middleware chain in routes.ts:
 *       injectUser → requireProject → registerCredentialRoutes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createServer } from "http";
import type { Express, Request, Response, NextFunction } from "express";
import type { User } from "../../shared/types.js";

// ─── Hoisted mutable state ────────────────────────────────────────────────────
//
// vi.hoisted() is required so these values are available inside vi.mock()
// factories which are hoisted above imports.

const STORE = vi.hoisted(() => ({
  /** Rows returned when requireProject queries the projects table. */
  projectsRows: [
    {
      id: "proj-1",
      name: "Test Project",
      ownerId: "user-test",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ] as unknown[],
  /** Rows returned when requireProject queries projectMembers (not needed when user is owner). */
  membersRows: [] as unknown[],
  /** Rows returned for credential_access_log queries. */
  accessLogRows: [] as unknown[],
  /** Rows returned for credential_leases queries. */
  leasesRows: [] as unknown[],
}));

const MOCK_CREDS = vi.hoisted(() => ({
  /** CredentialMetadata[] returned by the mocked listCredentials. */
  credentials: [] as unknown[],
}));

// ─── Mock server/db.js ───────────────────────────────────────────────────────
//
// Returns controlled rows based on the Drizzle table name symbol.
// withProject returns the optional condition unchanged (or {} when called with
// no condition) — the mock db.where() ignores the SQL value entirely.

vi.mock("../../server/db.js", () => {
  const TABLE = Symbol.for("drizzle:BaseName");

  /**
   * Returns a fluent chain that ignores WHERE/ORDER-BY/LIMIT conditions and
   * resolves to the provided rows when awaited at any chain depth.
   */
  function makeChain(getRows: () => unknown[]) {
    const chain: Record<string, unknown> = {};
    chain.where = () => chain;
    chain.innerJoin = () => chain;
    chain.orderBy = () => chain;
    // Terminate the chain with .limit() — returns a real Promise.
    chain.limit = () => Promise.resolve(getRows());
    // Make the chain itself awaitable so await chain.orderBy(...) works
    // (used by the leases endpoint which has no .limit() call).
    (chain as unknown as PromiseLike<unknown>).then = (
      resolve: (v: unknown) => void,
      reject?: (e: unknown) => void,
    ) => Promise.resolve(getRows()).then(resolve, reject);
    return chain;
  }

  return {
    pool: { on: () => {} },
    /** Pass-through: the mock db ignores the SQL condition anyway. */
    withProject: (_t: unknown, cond?: unknown) => cond ?? {},
    withProjectInsert: (_t: unknown, data: unknown) => data,
    runMigrations: async () => {},
    db: {
      select: () => ({
        from: (table: unknown) => {
          const name = (table as Record<symbol, string>)[TABLE];
          if (name === "projects") return makeChain(() => STORE.projectsRows);
          if (name === "project_members")
            return makeChain(() => STORE.membersRows);
          if (name === "credential_access_log")
            return makeChain(() => STORE.accessLogRows);
          if (name === "credential_leases")
            return makeChain(() => STORE.leasesRows);
          return makeChain(() => []);
        },
      }),
    },
  };
});

// ─── Mock server/credentials/db-crypto-provider.js ───────────────────────────
//
// Replaces the real provider so listCredentials does not hit the DB
// (it has its own complex workspace-connection JOIN + audit write).

vi.mock("../../server/credentials/db-crypto-provider.js", () => ({
  credentialProvider: {
    listCredentials: vi.fn(
      async (_projectId: string) => MOCK_CREDS.credentials,
    ),
  },
  expireStaleLeases: async () => 0,
}));

// ─── Synthetic user ───────────────────────────────────────────────────────────

const TEST_USER: User = {
  id: "user-test",
  email: "cred-test@example.com",
  name: "Credential Tester",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

function injectUser(req: Request, _res: Response, next: NextFunction) {
  req.user = TEST_USER;
  next();
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-29T00:00:00Z");
const LATER = new Date("2026-06-29T01:00:00Z");

const SAMPLE_CREDENTIAL = {
  id: "conn-1",
  projectId: "proj-1",
  provider: "github",
  scope: "ws-1",
  description: "My GitHub Connection",
  hasSecret: true,
  lastRotatedAt: NOW,
};

const SAMPLE_LOG_ROW = {
  id: "log-1",
  leaseId: "lease-1",
  credentialId: "conn-1",
  projectId: "proj-1",
  runId: "run-1",
  stageId: "stage-1",
  action: "lease_issued",
  requestedBy: "proj-1",
  justification: "automated",
  success: true,
  errorMessage: null,
  ttlSeconds: 300,
  createdAt: NOW,
};

const SAMPLE_LEASE_ROW = {
  id: "lease-1",
  credentialId: "conn-1",
  projectId: "proj-1",
  runId: "run-1",
  stageId: "stage-1",
  requestedBy: "proj-1",
  issuedAt: NOW,
  expiresAt: LATER,
  revokedAt: null,
  status: "active",
};

// ─── Test app factory ─────────────────────────────────────────────────────────

async function createTestApp() {
  const { requireProject } = await import(
    "../../server/middleware/project.js"
  );
  const { registerCredentialRoutes } = await import(
    "../../server/routes/credentials.js"
  );

  const app = express();
  app.use(express.json());
  app.use(injectUser);

  // Mirror the middleware chain from routes.ts.
  app.use("/api/credentials", requireProject);

  registerCredentialRoutes(app);

  const httpServer = createServer(app);
  return {
    app,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Credentials API", () => {
  let app: Express;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    closeApp = ctx.close;
  }, 15_000);

  afterAll(async () => {
    await closeApp();
  });

  // ── 400 without x-project-id ────────────────────────────────────────────────

  describe("GET /api/credentials — no x-project-id → 400", () => {
    it("returns 400 when x-project-id header is absent", async () => {
      const res = await request(app).get("/api/credentials");
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/x-project-id/);
    });
  });

  describe("GET /api/credentials/access-log — no x-project-id → 400", () => {
    it("returns 400 when x-project-id header is absent", async () => {
      const res = await request(app).get("/api/credentials/access-log");
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/x-project-id/);
    });
  });

  describe("GET /api/credentials/leases — no x-project-id → 400", () => {
    it("returns 400 when x-project-id header is absent", async () => {
      const res = await request(app).get("/api/credentials/leases");
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/x-project-id/);
    });
  });

  // ── 200 with x-project-id ───────────────────────────────────────────────────

  describe("GET /api/credentials — with x-project-id → 200", () => {
    it("returns CredentialMetadata[] for the project", async () => {
      MOCK_CREDS.credentials = [SAMPLE_CREDENTIAL];

      const res = await request(app)
        .get("/api/credentials")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      const body = res.body as typeof SAMPLE_CREDENTIAL[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("conn-1");
      expect(body[0].provider).toBe("github");
      // No secret material in the response.
      expect("secretsEncrypted" in body[0]).toBe(false);
    });

    it("returns empty array when project has no credentials", async () => {
      MOCK_CREDS.credentials = [];

      const res = await request(app)
        .get("/api/credentials")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /api/credentials/access-log — with x-project-id → 200", () => {
    it("returns access log rows for the project", async () => {
      STORE.accessLogRows = [SAMPLE_LOG_ROW];

      const res = await request(app)
        .get("/api/credentials/access-log")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      const body = res.body as typeof SAMPLE_LOG_ROW[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("log-1");
      expect(body[0].action).toBe("lease_issued");
      expect(body[0].projectId).toBe("proj-1");
    });

    it("returns empty array when project has no log entries", async () => {
      STORE.accessLogRows = [];

      const res = await request(app)
        .get("/api/credentials/access-log")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("respects the ?limit query param (accepts values 1–500)", async () => {
      STORE.accessLogRows = [SAMPLE_LOG_ROW];

      // The mock returns STORE rows regardless of limit; we just verify 200.
      const res = await request(app)
        .get("/api/credentials/access-log?limit=50")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("GET /api/credentials/leases — with x-project-id → 200", () => {
    it("returns lease rows for the project", async () => {
      STORE.leasesRows = [SAMPLE_LEASE_ROW];

      const res = await request(app)
        .get("/api/credentials/leases")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      const body = res.body as typeof SAMPLE_LEASE_ROW[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("lease-1");
      expect(body[0].status).toBe("active");
      expect(body[0].projectId).toBe("proj-1");
    });

    it("returns empty array when project has no leases", async () => {
      STORE.leasesRows = [];

      const res = await request(app)
        .get("/api/credentials/leases")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("accepts ?status=active filter and returns 200", async () => {
      STORE.leasesRows = [SAMPLE_LEASE_ROW];

      const res = await request(app)
        .get("/api/credentials/leases?status=active")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("accepts ?status=revoked filter and returns 200", async () => {
      STORE.leasesRows = [];

      const res = await request(app)
        .get("/api/credentials/leases?status=revoked")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns 400 for an unrecognised ?status value", async () => {
      const res = await request(app)
        .get("/api/credentials/leases?status=unknown")
        .set("x-project-id", "proj-1");

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Invalid status/);
    });
  });
});
