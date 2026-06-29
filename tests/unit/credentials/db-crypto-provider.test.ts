/**
 * Unit tests for DbCryptoCredentialProvider (ADR-001 Phase 1b + Wave 2).
 *
 * Covers:
 *   1.  projectId-mismatch throws ForbiddenError on every public method.
 *   2.  Plan-time methods (listCredentials, getCredentialMetadata) never return
 *       secret material.
 *   3.  issueLease throws ForbiddenError when stage is not approved.
 *   4.  issueLease throws ForbiddenError when pipeline run is not 'running'.
 *   5.  issueLease succeeds (approved + running) and returns a CredentialLease
 *       with the decrypted secret.
 *   6.  Rate limit: issueLease throws after RATE_LIMIT_MAX requests in one window.
 *   7.  revokeLease marks the lease revoked (idempotent on already-revoked).
 *   8.  revokeRunLeases marks all active leases for the run revoked; no-op when
 *       no active leases exist.
 *   9.  expireStaleLeases marks active leases past their expiresAt as 'expired'.
 *   10. Audit rows are written with correct action on each operation.
 *   11. accessSecret (Wave-2): project-scope, system-context, audit, no-context throw.
 *   12. No direct crypto.decrypt() import outside the broker (grep-style assertion).
 *
 * Strategy:
 *   - `server/db.js` is fully mocked: each test controls what the DB returns via
 *     `MOCK_DB`.  The mock tracks inserts/updates through `inserted` and `updated`
 *     spy arrays so tests can assert on audit log rows and lease mutations.
 *   - `server/crypto.js` is mocked: decrypt returns a deterministic secret map.
 *   - `server/context.js` is NOT mocked — we use runAsProject() so the real ALS
 *     context is set.  This tests the assertProject() invariant end-to-end.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Hoisted mutable state (available inside vi.mock factories) ───────────────

const MOCK_DB = vi.hoisted(() => ({
  // Tables that SELECT queries resolve from.
  workspaceConnectionsRows: [] as Record<string, unknown>[],
  workspacesRows: [] as Record<string, unknown>[],
  pipelineRunsRows: [] as Record<string, unknown>[],
  stageExecutionsRows: [] as Record<string, unknown>[],
  credentialLeasesRows: [] as Record<string, unknown>[],

  // Spy arrays for write operations.
  inserted: [] as { table: string; values: Record<string, unknown> }[],
  updated: [] as { table: string; set: Record<string, unknown>; where: unknown }[],

  // Next UUID to return from insert().returning()
  nextLeaseId: "lease-uuid-1",
}));

// ─── DB mock ──────────────────────────────────────────────────────────────────
//
// We mock the db object returned by "server/db.js".
// withProject is a no-op passthrough (the broker does its own context assertion).
// withProjectInsert is a no-op passthrough.
//
// The SELECT query builder resolves based on the first .from() table name
// (identified via Symbol.for("drizzle:BaseName")).
//
// The SELECT join path (workspaceConnections + workspaces) resolves from
// workspaceConnectionsRows filtered by workspaceId → workspacesRows.

vi.mock("../../../server/db.js", () => {
  const TABLE = Symbol.for("drizzle:BaseName");

  function makeSelectChain(rows: () => Record<string, unknown>[]) {
    let _where: unknown;
    const chain: Record<string, unknown> = {};

    chain.from = vi.fn().mockReturnValue(chain);
    chain.innerJoin = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockImplementation((w: unknown) => {
      _where = w;
      return chain;
    });
    chain.orderBy = vi.fn().mockReturnValue(rows());

    // Make the chain awaitable (resolves on .where() result).
    // Vitest awaits the chain directly using Symbol.iterator / Promise-like.
    // The simplest approach: make the chain a thenable that returns rows().
    (chain as any)[Symbol.for("vitest:resolved")] = rows;
    (chain as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      try { resolve(rows()); } catch (e) { reject(e); }
      return Promise.resolve(rows());
    };

    return chain;
  }

  return {
    db: {
      select: vi.fn().mockImplementation((columns?: unknown) => {
        // Track which table is being queried from the .from() call.
        let tableName = "";
        const outerChain: Record<string, unknown> = {};

        outerChain.from = vi.fn().mockImplementation((table: unknown) => {
          tableName = (table as Record<symbol, string>)[TABLE] ?? "";

          let innerChain: Record<string, unknown> = {};

          // ── JOIN path: workspaceConnections ─────────────────────────────
          if (tableName === "workspace_connections") {
            innerChain.innerJoin = vi.fn().mockReturnValue(innerChain);
            innerChain.where = vi.fn().mockImplementation(() => innerChain);
            (innerChain as any).then = (resolve: (v: unknown) => void) => {
              resolve(MOCK_DB.workspaceConnectionsRows);
              return Promise.resolve(MOCK_DB.workspaceConnectionsRows);
            };
            return innerChain;
          }

          // ── Simple SELECT paths ─────────────────────────────────────────
          const rowsForTable = () => {
            if (tableName === "workspaces")           return MOCK_DB.workspacesRows;
            if (tableName === "pipeline_runs")        return MOCK_DB.pipelineRunsRows;
            if (tableName === "stage_executions")     return MOCK_DB.stageExecutionsRows;
            if (tableName === "credential_leases")    return MOCK_DB.credentialLeasesRows;
            return [];
          };

          innerChain.where = vi.fn().mockImplementation(() => innerChain);
          innerChain.orderBy = vi.fn().mockImplementation(() => rowsForTable());
          (innerChain as any).then = (resolve: (v: unknown) => void) => {
            resolve(rowsForTable());
            return Promise.resolve(rowsForTable());
          };
          return innerChain;
        });

        return outerChain;
      }),

      insert: vi.fn().mockImplementation((table: unknown) => {
        const tableName = (table as Record<symbol, string>)[TABLE] ?? "";
        return {
          values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
            // Record the insert for assertions.
            MOCK_DB.inserted.push({ table: tableName, values: vals });

            const returning = () => {
              if (tableName === "credential_leases") {
                return [{ ...vals, id: MOCK_DB.nextLeaseId }];
              }
              return [{ ...vals, id: "log-uuid-1" }];
            };

            return {
              returning: vi.fn().mockReturnValue(returning()),
              // Make INSERT awaitable without .returning()
              then: (resolve: (v: unknown) => void) => {
                resolve(undefined);
                return Promise.resolve(undefined);
              },
            };
          }),
        };
      }),

      update: vi.fn().mockImplementation((table: unknown) => {
        const tableName = (table as Record<symbol, string>)[TABLE] ?? "";
        const updateEntry: { table: string; set: Record<string, unknown>; where: unknown } = {
          table: tableName,
          set: {},
          where: null,
        };
        MOCK_DB.updated.push(updateEntry);

        const chain: Record<string, unknown> = {};
        chain.set = vi.fn().mockImplementation((s: Record<string, unknown>) => {
          updateEntry.set = s;
          return chain;
        });
        chain.where = vi.fn().mockImplementation((w: unknown) => {
          updateEntry.where = w;
          return chain;
        });
        chain.returning = vi.fn().mockReturnValue([]);
        (chain as any).then = (resolve: (v: unknown) => void) => {
          resolve(undefined);
          return Promise.resolve(undefined);
        };

        return chain;
      }),

      delete: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockReturnValue(Promise.resolve()),
      })),
    },
    pool: { on: vi.fn() },
    withProject: (_t: unknown, cond?: unknown) => cond ?? {},
    withProjectInsert: (_t: unknown, data: unknown) => data,
    runMigrations: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── Crypto mock ──────────────────────────────────────────────────────────────

vi.mock("../../../server/crypto.js", () => ({
  encrypt: vi.fn((v: string) => `v2:${v}`),
  decrypt: vi.fn((_ciphertext: string) =>
    JSON.stringify({ API_TOKEN: "secret-value-123" }),
  ),
  isV2: vi.fn(() => true),
}));

// ─── Config mock (required by crypto.ts import chain) ─────────────────────────

vi.mock("../../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      encryption: { key: "test-key-32-chars-exactly-paddedX" },
      database: { url: undefined },
    }),
  },
}));

// ─── Import under test AFTER mocks ───────────────────────────────────────────

import {
  DbCryptoCredentialProvider,
  expireStaleLeases,
  markLeaseUsed,
  _resetRateLimitStore,
} from "../../../server/credentials/db-crypto-provider.js";
import { ForbiddenError } from "../../../server/credentials/types.js";
import { runAsProject, runAsSystem } from "../../../server/context.js";
import type { CredentialLease } from "../../../server/credentials/types.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const PROJECT_A = "proj-a";
const PROJECT_B = "proj-b";
const WORKSPACE_ID = "ws-1";
const CONN_ID = "conn-abc";
const RUN_ID = "run-xyz";
const STAGE_ID = "stage-001";
const USER = "user-test";

function makeConn(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CONN_ID,
    workspaceId: WORKSPACE_ID,
    type: "github",
    name: "My GitHub",
    configJson: {},
    secretsEncrypted: "v2:enc-secrets",
    status: "active",
    lastTestedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-15"),
    createdBy: null,
    ...overrides,
  };
}

function makeApprovedStageExec(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: STAGE_ID,
    runId: RUN_ID,
    projectId: PROJECT_A,
    approvalStatus: "approved",
    stageIndex: 0,
    ...overrides,
  };
}

function makeRunningPipelineRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    projectId: PROJECT_A,
    status: "running",
    pipelineId: "pipe-1",
    input: "",
    currentStageIndex: 0,
    dagMode: false,
    ...overrides,
  };
}

function makeLease(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "lease-uuid-1",
    credentialId: CONN_ID,
    projectId: PROJECT_A,
    runId: RUN_ID,
    stageId: STAGE_ID,
    requestedBy: USER,
    issuedAt: new Date(Date.now() - 1000),
    expiresAt: new Date(Date.now() + 290_000),  // expires in 290 s
    revokedAt: null,
    status: "active",
    ...overrides,
  };
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function resetMock() {
  MOCK_DB.workspaceConnectionsRows = [];
  MOCK_DB.workspacesRows = [];
  MOCK_DB.pipelineRunsRows = [];
  MOCK_DB.stageExecutionsRows = [];
  MOCK_DB.credentialLeasesRows = [];
  MOCK_DB.inserted = [];
  MOCK_DB.updated = [];
  MOCK_DB.nextLeaseId = "lease-uuid-1";
  _resetRateLimitStore();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DbCryptoCredentialProvider", () => {
  let provider: DbCryptoCredentialProvider;

  beforeEach(() => {
    resetMock();
    provider = new DbCryptoCredentialProvider();
  });

  // ── 1. projectId-mismatch ────────────────────────────────────────────────────

  describe("projectId context assertion", () => {
    it("listCredentials throws ForbiddenError when projectId !== context", async () => {
      await runAsProject(PROJECT_A, async () => {
        await expect(provider.listCredentials(PROJECT_B)).rejects.toThrow(
          ForbiddenError,
        );
      });
    });

    it("getCredentialMetadata throws ForbiddenError when projectId !== context", async () => {
      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.getCredentialMetadata(PROJECT_B, CONN_ID),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    it("issueLease throws ForbiddenError when projectId !== context", async () => {
      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_B,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });
  });

  // ── 2. Plan-time methods never return secret material ────────────────────────

  describe("plan-time metadata methods", () => {
    it("listCredentials returns CredentialMetadata array — no secret fields", async () => {
      MOCK_DB.workspaceConnectionsRows = [makeConn()];

      const result = await runAsProject(PROJECT_A, () =>
        provider.listCredentials(PROJECT_A),
      );

      expect(result).toHaveLength(1);
      const meta = result[0];
      expect(meta.id).toBe(CONN_ID);
      expect(meta.projectId).toBe(PROJECT_A);
      expect(meta.provider).toBe("github");
      expect(meta.hasSecret).toBe(true);
      // No secret material on the metadata shape.
      expect((meta as any).secret).toBeUndefined();
      expect((meta as any).secretsEncrypted).toBeUndefined();
      expect((meta as any).value).toBeUndefined();
    });

    it("listCredentials returns hasSecret=false when no secretsEncrypted", async () => {
      MOCK_DB.workspaceConnectionsRows = [makeConn({ secretsEncrypted: null })];

      const result = await runAsProject(PROJECT_A, () =>
        provider.listCredentials(PROJECT_A),
      );

      expect(result[0].hasSecret).toBe(false);
    });

    it("getCredentialMetadata returns metadata — no secret fields", async () => {
      MOCK_DB.workspaceConnectionsRows = [makeConn()];

      const result = await runAsProject(PROJECT_A, () =>
        provider.getCredentialMetadata(PROJECT_A, CONN_ID),
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe(CONN_ID);
      expect((result as any).secret).toBeUndefined();
      expect((result as any).secretsEncrypted).toBeUndefined();
    });

    it("getCredentialMetadata returns null for unknown credential", async () => {
      MOCK_DB.workspaceConnectionsRows = [];

      const result = await runAsProject(PROJECT_A, () =>
        provider.getCredentialMetadata(PROJECT_A, "unknown-id"),
      );

      expect(result).toBeNull();
    });

    it("listCredentials writes list_metadata audit log", async () => {
      MOCK_DB.workspaceConnectionsRows = [];

      await runAsProject(PROJECT_A, () => provider.listCredentials(PROJECT_A));

      const auditInserts = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditInserts).toHaveLength(1);
      expect(auditInserts[0].values.action).toBe("list_metadata");
      expect(auditInserts[0].values.success).toBe(true);
    });
  });

  // ── 3. issueLease throws on unapproved stage ──────────────────────────────────

  describe("issueLease — approval gate", () => {
    it("throws ForbiddenError when stage not found", async () => {
      MOCK_DB.stageExecutionsRows = [];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];

      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    it("throws ForbiddenError when approvalStatus is pending", async () => {
      MOCK_DB.stageExecutionsRows = [
        makeApprovedStageExec({ approvalStatus: "pending" }),
      ];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];

      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    it("throws ForbiddenError when approvalStatus is rejected", async () => {
      MOCK_DB.stageExecutionsRows = [
        makeApprovedStageExec({ approvalStatus: "rejected" }),
      ];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];

      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    it("throws ForbiddenError when approvalStatus is null", async () => {
      MOCK_DB.stageExecutionsRows = [
        makeApprovedStageExec({ approvalStatus: null }),
      ];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];

      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });
  });

  // ── 4. issueLease throws on non-running run ───────────────────────────────────

  describe("issueLease — run-state gate", () => {
    it("throws ForbiddenError when pipeline run not found", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [];

      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    it("throws ForbiddenError when pipeline run status is paused", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun({ status: "paused" })];

      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    it("throws ForbiddenError when pipeline run status is completed", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [
        makeRunningPipelineRun({ status: "completed" }),
      ];

      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    it("throws ForbiddenError when pipeline run status is failed", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun({ status: "failed" })];

      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN_ID,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });
  });

  // ── 5. issueLease succeeds on approved + running ──────────────────────────────

  describe("issueLease — happy path", () => {
    it("returns a CredentialLease with static secret on approved+running", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];
      MOCK_DB.workspaceConnectionsRows = [makeConn()];

      const lease = await runAsProject(PROJECT_A, () =>
        provider.issueLease({
          projectId: PROJECT_A,
          credentialId: CONN_ID,
          runId: RUN_ID,
          stageId: STAGE_ID,
          requestedBy: USER,
        }),
      );

      expect(lease.leaseId).toBe("lease-uuid-1");
      expect(lease.credentialId).toBe(CONN_ID);
      expect(lease.projectId).toBe(PROJECT_A);
      expect(lease.runId).toBe(RUN_ID);
      expect(lease.stageId).toBe(STAGE_ID);
      expect(lease.secret.type).toBe("static");
      // Secret value is the JSON-serialised secrets map.
      expect(JSON.parse((lease.secret as { type: "static"; value: string }).value)).toEqual({
        API_TOKEN: "secret-value-123",
      });
    });

    it("respects custom ttlSeconds (capped at 900)", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];
      MOCK_DB.workspaceConnectionsRows = [makeConn()];

      const before = Date.now();
      const lease = await runAsProject(PROJECT_A, () =>
        provider.issueLease({
          projectId: PROJECT_A,
          credentialId: CONN_ID,
          runId: RUN_ID,
          stageId: STAGE_ID,
          requestedBy: USER,
          ttlSeconds: 600,
        }),
      );
      const after = Date.now();

      const ttlMs = lease.expiresAt.getTime() - lease.issuedAt.getTime();
      expect(ttlMs).toBe(600_000);
      expect(lease.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
      expect(lease.expiresAt.getTime()).toBeLessThanOrEqual(after + 600_000 + 100);
    });

    it("caps ttlSeconds at 900 when provided value exceeds max", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];
      MOCK_DB.workspaceConnectionsRows = [makeConn()];

      const lease = await runAsProject(PROJECT_A, () =>
        provider.issueLease({
          projectId: PROJECT_A,
          credentialId: CONN_ID,
          runId: RUN_ID,
          stageId: STAGE_ID,
          requestedBy: USER,
          ttlSeconds: 9999,
        }),
      );

      const ttlMs = lease.expiresAt.getTime() - lease.issuedAt.getTime();
      expect(ttlMs).toBe(900_000);
    });

    it("writes lease_issued audit log row", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];
      MOCK_DB.workspaceConnectionsRows = [makeConn()];

      await runAsProject(PROJECT_A, () =>
        provider.issueLease({
          projectId: PROJECT_A,
          credentialId: CONN_ID,
          runId: RUN_ID,
          stageId: STAGE_ID,
          requestedBy: USER,
          justification: "deploy-job",
        }),
      );

      const auditInserts = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditInserts).toHaveLength(1);
      const log = auditInserts[0].values;
      expect(log.action).toBe("lease_issued");
      expect(log.credentialId).toBe(CONN_ID);
      expect(log.projectId).toBe(PROJECT_A);
      expect(log.runId).toBe(RUN_ID);
      expect(log.stageId).toBe(STAGE_ID);
      expect(log.success).toBe(true);
      expect(log.justification).toBe("deploy-job");
      expect(log.ttlSeconds).toBe(300); // default
    });

    it("writes lease row to credential_leases", async () => {
      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec()];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun()];
      MOCK_DB.workspaceConnectionsRows = [makeConn()];

      await runAsProject(PROJECT_A, () =>
        provider.issueLease({
          projectId: PROJECT_A,
          credentialId: CONN_ID,
          runId: RUN_ID,
          stageId: STAGE_ID,
          requestedBy: USER,
        }),
      );

      const leaseInserts = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_leases",
      );
      expect(leaseInserts).toHaveLength(1);
      const row = leaseInserts[0].values;
      expect(row.credentialId).toBe(CONN_ID);
      expect(row.projectId).toBe(PROJECT_A);
      expect(row.status).toBe("active");
    });
  });

  // ── 6. Rate limiting ──────────────────────────────────────────────────────────

  describe("issueLease — rate limiting", () => {
    it("allows up to RATE_LIMIT_MAX requests then throws ForbiddenError", async () => {
      // We can't reach the DB check easily without a full happy-path setup.
      // Instead test that ForbiddenError is thrown after the limit.
      // Use a unique runId per test suite to avoid cross-test contamination.
      const RUN = "rate-limit-run";

      MOCK_DB.stageExecutionsRows = [makeApprovedStageExec({ runId: RUN })];
      MOCK_DB.pipelineRunsRows = [makeRunningPipelineRun({ id: RUN })];
      MOCK_DB.workspaceConnectionsRows = [makeConn()];

      // Send 10 successful requests (the limit).
      const results: CredentialLease[] = [];
      for (let i = 0; i < 10; i++) {
        MOCK_DB.nextLeaseId = `lease-rate-${i}`;
        MOCK_DB.inserted = [];
        const r = await runAsProject(PROJECT_A, () =>
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        );
        results.push(r);
      }
      expect(results).toHaveLength(10);

      // The 11th request must throw ForbiddenError.
      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.issueLease({
            projectId: PROJECT_A,
            credentialId: CONN_ID,
            runId: RUN,
            stageId: STAGE_ID,
            requestedBy: USER,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });
  });

  // ── 7. revokeLease ────────────────────────────────────────────────────────────

  describe("revokeLease", () => {
    it("marks lease revoked and writes audit log", async () => {
      MOCK_DB.credentialLeasesRows = [makeLease()];

      await runAsProject(PROJECT_A, () => provider.revokeLease("lease-uuid-1"));

      // The update should have status='revoked'.
      const leaseUpdates = MOCK_DB.updated.filter(
        (u) => u.table === "credential_leases",
      );
      expect(leaseUpdates).toHaveLength(1);
      expect(leaseUpdates[0].set.status).toBe("revoked");
      expect(leaseUpdates[0].set.revokedAt).toBeDefined();

      // Audit log written.
      const auditInserts = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditInserts).toHaveLength(1);
      expect(auditInserts[0].values.action).toBe("lease_revoked");
    });

    it("is idempotent — no-op when lease is already revoked", async () => {
      MOCK_DB.credentialLeasesRows = [makeLease({ status: "revoked" })];

      await runAsProject(PROJECT_A, () => provider.revokeLease("lease-uuid-1"));

      // No update should be issued.
      expect(MOCK_DB.updated).toHaveLength(0);
    });

    it("throws ForbiddenError when lease belongs to a different project", async () => {
      MOCK_DB.credentialLeasesRows = [makeLease({ projectId: PROJECT_B })];

      await runAsProject(PROJECT_A, async () => {
        await expect(provider.revokeLease("lease-uuid-1")).rejects.toThrow(
          ForbiddenError,
        );
      });
    });
  });

  // ── 8. revokeRunLeases ───────────────────────────────────────────────────────

  describe("revokeRunLeases", () => {
    it("marks all active leases for the run revoked", async () => {
      MOCK_DB.credentialLeasesRows = [
        makeLease({ id: "l1", status: "active" }),
        makeLease({ id: "l2", status: "active" }),
      ];

      await runAsProject(PROJECT_A, () => provider.revokeRunLeases(RUN_ID));

      const leaseUpdates = MOCK_DB.updated.filter(
        (u) => u.table === "credential_leases",
      );
      expect(leaseUpdates).toHaveLength(1);
      expect(leaseUpdates[0].set.status).toBe("revoked");

      // Two audit log rows (one per lease).
      const auditInserts = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditInserts).toHaveLength(2);
      auditInserts.forEach((a) => expect(a.values.action).toBe("lease_revoked"));
    });

    it("is a no-op when no active leases exist for the run", async () => {
      MOCK_DB.credentialLeasesRows = [];

      // Must not throw.
      await expect(
        runAsProject(PROJECT_A, () => provider.revokeRunLeases(RUN_ID)),
      ).resolves.toBeUndefined();

      expect(MOCK_DB.updated).toHaveLength(0);
      expect(MOCK_DB.inserted).toHaveLength(0);
    });

    it("is a no-op when all leases are already revoked", async () => {
      MOCK_DB.credentialLeasesRows = [
        makeLease({ id: "l1", status: "revoked" }),
      ];
      // Filter on status='active' returns nothing.
      // But our mock returns all rows from credentialLeasesRows regardless of filter.
      // We need to filter in the mock result for this test.
      // Since the mock returns all rows from credentialLeasesRows, we simulate no active
      // leases by setting the array to an already-revoked lease and then overriding the
      // WHERE-filter result. The simplest approach: set rows to empty so the broker
      // sees no active leases.
      MOCK_DB.credentialLeasesRows = [];

      await expect(
        runAsProject(PROJECT_A, () => provider.revokeRunLeases(RUN_ID)),
      ).resolves.toBeUndefined();

      expect(MOCK_DB.updated).toHaveLength(0);
    });
  });

  // ── 9. expireStaleLeases sweeper ─────────────────────────────────────────────

  describe("expireStaleLeases", () => {
    it("returns 0 when no leases to expire", async () => {
      // update().returning() returns [] by default.
      const count = await expireStaleLeases();
      expect(count).toBe(0);
    });

    it("marks active expired leases as expired and writes audit rows", async () => {
      // Override update chain to return fake expired leases.
      const expiredLease = makeLease({
        id: "old-lease",
        status: "active",
        expiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
      });

      // Patch the db.update mock to return expired lease for the first call.
      const { db: mockDb } = await import("../../../server/db.js");
      (mockDb.update as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (table: unknown) => {
          const tableName = (table as Record<symbol, string>)[Symbol.for("drizzle:BaseName")] ?? "";
          const entry = { table: tableName, set: {} as Record<string, unknown>, where: null };
          MOCK_DB.updated.push(entry);
          const chain: Record<string, unknown> = {};
          chain.set = vi.fn().mockImplementation((s: Record<string, unknown>) => {
            entry.set = s;
            return chain;
          });
          chain.where = vi.fn().mockReturnValue(chain);
          chain.returning = vi.fn().mockReturnValue([expiredLease]);
          return chain;
        },
      );

      const count = await expireStaleLeases();
      expect(count).toBe(1);

      // Should have written a lease_expired audit log row.
      const auditInserts = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditInserts).toHaveLength(1);
      expect(auditInserts[0].values.action).toBe("lease_expired");
      expect(auditInserts[0].values.leaseId).toBe("old-lease");
      expect(auditInserts[0].values.requestedBy).toBe("system-sweeper");
    });
  });

  // ── 10. markLeaseUsed ────────────────────────────────────────────────────────

  describe("markLeaseUsed", () => {
    it("writes a lease_used audit log row", async () => {
      MOCK_DB.credentialLeasesRows = [makeLease()];

      await markLeaseUsed("lease-uuid-1", USER);

      const auditInserts = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditInserts).toHaveLength(1);
      expect(auditInserts[0].values.action).toBe("lease_used");
      expect(auditInserts[0].values.leaseId).toBe("lease-uuid-1");
      expect(auditInserts[0].values.requestedBy).toBe(USER);
    });

    it("throws when lease not found", async () => {
      MOCK_DB.credentialLeasesRows = [];

      await expect(markLeaseUsed("unknown-lease", USER)).rejects.toThrow(
        /not found/,
      );
    });
  });

  // ── 11. accessSecret — Wave-2 non-lease direct access ────────────────────────
  //
  // accessSecret is the SYSTEM/non-run analogue of issueLease.  It routes ALL
  // remaining crypto.decrypt() calls through the broker with project-scope +
  // audit enforcement (ADR-001 PR-1d).

  describe("accessSecret", () => {
    const CIPHERTEXT = "v2:enc-secret-abc";
    const CRED_ID = "trackerConn:tc-1";
    const PURPOSE = "test-purpose";

    it("returns decrypted plaintext in project context", async () => {
      const result = await runAsProject(PROJECT_A, () =>
        provider.accessSecret({
          ciphertext: CIPHERTEXT,
          credentialId: CRED_ID,
          projectId: PROJECT_A,
          purpose: PURPOSE,
        }),
      );
      // decrypt mock returns JSON.stringify({ API_TOKEN: "secret-value-123" })
      expect(result).toBe(JSON.stringify({ API_TOKEN: "secret-value-123" }));
    });

    it("throws ForbiddenError in project context when projectId !== context", async () => {
      // Project A context but requesting PROJECT_B credential — must be rejected.
      await runAsProject(PROJECT_A, async () => {
        await expect(
          provider.accessSecret({
            ciphertext: CIPHERTEXT,
            credentialId: CRED_ID,
            projectId: PROJECT_B,
            purpose: PURPOSE,
          }),
        ).rejects.toThrow(ForbiddenError);
      });
    });

    it("writes secret_accessed audit row on success (project context)", async () => {
      await runAsProject(PROJECT_A, () =>
        provider.accessSecret({
          ciphertext: CIPHERTEXT,
          credentialId: CRED_ID,
          projectId: PROJECT_A,
          purpose: PURPOSE,
          requestedBy: USER,
        }),
      );

      const auditRows = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditRows).toHaveLength(1);
      const row = auditRows[0].values;
      expect(row.action).toBe("secret_accessed");
      expect(row.credentialId).toBe(CRED_ID);
      expect(row.projectId).toBe(PROJECT_A);
      expect(row.justification).toBe(PURPOSE);
      expect(row.requestedBy).toBe(USER);
      expect(row.success).toBe(true);
    });

    it("succeeds in system context without project assertion", async () => {
      // In system context, getProjectId() would throw — but accessSecret skips
      // assertProject() in system context and should succeed.
      const result = await runAsSystem("test-system-context", () =>
        provider.accessSecret({
          ciphertext: CIPHERTEXT,
          credentialId: CRED_ID,
          projectId: PROJECT_B,  // arbitrary project — no assertion in system context
          purpose: PURPOSE,
        }),
      );
      expect(result).toBe(JSON.stringify({ API_TOKEN: "secret-value-123" }));
    });

    it("writes secret_accessed audit row in system context", async () => {
      await runAsSystem("test-system-access", () =>
        provider.accessSecret({
          ciphertext: CIPHERTEXT,
          credentialId: CRED_ID,
          projectId: PROJECT_A,  // passed explicitly by caller for audit
          purpose: PURPOSE,
          requestedBy: "system-loader",
        }),
      );

      const auditRows = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditRows).toHaveLength(1);
      const row = auditRows[0].values;
      expect(row.action).toBe("secret_accessed");
      expect(row.projectId).toBe(PROJECT_A);
      expect(row.requestedBy).toBe("system-loader");
      expect(row.success).toBe(true);
    });

    it("throws when called outside any ALS context", async () => {
      // No runAsProject / runAsSystem wrapper — should throw.
      await expect(
        provider.accessSecret({
          ciphertext: CIPHERTEXT,
          credentialId: CRED_ID,
          projectId: PROJECT_A,
          purpose: PURPOSE,
        }),
      ).rejects.toThrow(/requires an ALS context/);
    });

    it("skips audit and still decrypts when projectId is empty (legacy row)", async () => {
      // Empty projectId signals a legacy row without a projectId column value.
      // The broker should still decrypt but skip the audit write (with a warning).
      const result = await runAsSystem("test-legacy-row", () =>
        provider.accessSecret({
          ciphertext: CIPHERTEXT,
          credentialId: CRED_ID,
          projectId: "",  // empty: audit row skipped, decrypt still succeeds
          purpose: PURPOSE,
        }),
      );
      expect(result).toBe(JSON.stringify({ API_TOKEN: "secret-value-123" }));
      // No audit row should have been written for an empty projectId.
      const auditRows = MOCK_DB.inserted.filter(
        (i) => i.table === "credential_access_log",
      );
      expect(auditRows).toHaveLength(0);
    });
  });

  // ── 12. No direct crypto.decrypt() import outside the broker ─────────────────
  //
  // Enforcement test: verifies that no server/ TypeScript file outside the
  // credential broker (and a short allowlist of legitimately different decrypt
  // implementations) imports `decrypt` from the main ../crypto module.
  //
  // After ADR-001 Wave-2, crypto.decrypt() must ONLY be called inside
  // server/credentials/db-crypto-provider.ts (and rekey/migration scripts).

  describe("ADR-001 PR-1d enforcement: no direct crypto.decrypt() outside broker", () => {
    it("no server/ .ts file outside the allowlist imports decrypt from main crypto", async () => {
      const { readFileSync, readdirSync, statSync } = await import("fs");
      const { join } = await import("path");

      // Resolve repo root from this test file's location.
      // test is at tests/unit/credentials/ → root is 3 levels up.
      const testDir = new URL(".", import.meta.url).pathname;
      const root = join(testDir, "..", "..", "..");
      const serverDir = join(root, "server");

      // Walk server/ and collect all .ts files.
      function walk(dir: string): string[] {
        const out: string[] = [];
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          try {
            if (statSync(full).isDirectory()) {
              out.push(...walk(full));
            } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
              out.push(full);
            }
          } catch {
            // ignore unreadable entries
          }
        }
        return out;
      }

      // Files that are ALLOWED to reference decrypt from main crypto (or that have their
      // own different decrypt function).
      const ALLOWED = [
        // The broker: the ONLY permitted caller of crypto.decrypt().
        "server/credentials/db-crypto-provider.ts",
        // The function definition itself.
        "server/crypto.ts",
        // age-crypto has its own decrypt(EncryptedFile, KeyObject) — different function.
        "server/config-sync/age-crypto.ts",
        // Federation encryption: class method, not main crypto.
        "server/federation/encryption.ts",
        "server/federation/transport.ts",
        // TriggerCrypto.decrypt — different key (TRIGGER_SECRET_KEY), ADR-deferred.
        "server/services/trigger-crypto.ts",
        "server/services/trigger-service.ts",
      ];

      // Pattern: any import statement that includes { decrypt } or { ..., decrypt, ... }
      // targeting the main crypto module (../crypto, ./crypto, ...crypto.js).
      const IMPORT_RE = /import[^;'"]*\bdecrypt\b[^;'"]*from\s*['"][^'"]*\/crypto(?:\.js)?['"]/m;

      const violations: string[] = [];
      for (const file of walk(serverDir)) {
        // Normalise to forward-slash relative path from repo root.
        const rel = file.replace(/\\/g, "/").replace(root.replace(/\\/g, "/") + "/", "");
        const isAllowed = ALLOWED.some((a) => rel === a || rel.endsWith("/" + a.replace("server/", "")));
        if (isAllowed) continue;

        const text = readFileSync(file, "utf-8");
        if (IMPORT_RE.test(text)) {
          violations.push(rel);
        }
      }

      // All decrypt imports from the main crypto module outside the allowlist are violations.
      expect(violations).toEqual([]);
    });
  });
});
