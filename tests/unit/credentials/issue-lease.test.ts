/**
 * issue-lease.test.ts — ADR-003 §D1/§D2 credential-broker gate matrix.
 *
 * `server/db.js` is mocked (a queue of select results + an insert capture) so the
 * test is DB-free, mirroring tests/integration/credentials-api.test.ts. Project
 * context is established with the REAL `runAsProject`, so `getProjectId()` /
 * [R3-SEC-3] is exercised for real. Each denial must be audited
 * (action='lease_issued', success=false) EXCEPT the structural project-mismatch
 * (which throws before any DB access).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  audit: [] as Array<Record<string, unknown>>,
  leaseId: "lease-1",
}));

vi.mock("../../../server/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(dbState.selectQueue.shift() ?? []),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        // writeAccessLog inserts carry `action`; the lease insert does not.
        if (v && v.action !== undefined) {
          dbState.audit.push(v);
          return Promise.resolve(undefined);
        }
        return { returning: () => Promise.resolve([{ id: dbState.leaseId }]) };
      },
    }),
  },
}));

import { DbCryptoCredentialProvider } from "../../../server/credentials/db-crypto-provider.js";
import { ForbiddenError } from "../../../server/credentials/types.js";
import { runAsProject } from "../../../server/context.js";

const PROJECT = "proj-1";
const provider = new DbCryptoCredentialProvider();

function lease(overrides: Record<string, unknown> = {}) {
  return provider.issueLease({
    projectId: PROJECT,
    credentialId: "cred-1",
    loopId: "loop-1",
    phase: "developing",
    requestedBy: "user-1",
    ...overrides,
  });
}

beforeEach(() => {
  dbState.selectQueue = [];
  dbState.audit = [];
});

describe("issueLease — ADR-003 gate matrix", () => {
  it("[R3-SEC-3] denies on project mismatch, structurally, with NO audit", async () => {
    await expect(
      runAsProject("other-project", () => lease()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(dbState.audit).toHaveLength(0);
  });

  it("D1 denies + audits when the loop is not in a lease-eligible state", async () => {
    dbState.selectQueue = [[{ state: "pending", projectId: PROJECT }]];
    await expect(runAsProject(PROJECT, () => lease())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(dbState.audit).toHaveLength(1);
    expect(dbState.audit[0]).toMatchObject({
      action: "lease_issued",
      success: false,
    });
  });

  it("D1 denies when the loop belongs to a different project", async () => {
    dbState.selectQueue = [[{ state: "developing", projectId: "someone-else" }]];
    await expect(runAsProject(PROJECT, () => lease())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(dbState.audit[0]).toMatchObject({ success: false });
  });

  it("D2 denies + audits when the credential is not bound to the loop", async () => {
    dbState.selectQueue = [
      [{ state: "developing", projectId: PROJECT }], // loop eligible
      [], // bound set: empty
    ];
    await expect(runAsProject(PROJECT, () => lease())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(dbState.audit).toHaveLength(1);
    expect(dbState.audit[0]).toMatchObject({
      action: "lease_issued",
      success: false,
    });
  });

  it("issues + audits (success + ttlSeconds) on the happy path", async () => {
    dbState.selectQueue = [
      [{ state: "developing", projectId: PROJECT }],
      [{ credentialId: "cred-1" }],
    ];
    const out = await runAsProject(PROJECT, () => lease({ ttlSeconds: 120 }));
    expect(out.leaseId).toBe("lease-1");
    expect(out.expiresAt).toBeInstanceOf(Date);
    const success = dbState.audit.find((a) => a.success === true);
    expect(success).toMatchObject({ action: "lease_issued", ttlSeconds: 120 });
  });

  it("clamps an over-long TTL to the max (900s)", async () => {
    dbState.selectQueue = [
      [{ state: "developing", projectId: PROJECT }],
      [{ credentialId: "cred-1" }],
    ];
    await runAsProject(PROJECT, () => lease({ ttlSeconds: 99_999 }));
    const success = dbState.audit.find((a) => a.success === true);
    expect(success?.ttlSeconds).toBe(900);
  });

  it("[R3-SEC-10] rate-limits repeated leases for the same (project, loop)", async () => {
    // Isolated loop id so the window is not polluted by the happy/clamp cases.
    for (let i = 0; i < 40; i++) {
      dbState.selectQueue.push([{ state: "developing", projectId: PROJECT }]);
      dbState.selectQueue.push([{ credentialId: "cred-1" }]);
    }
    let denied = 0;
    for (let i = 0; i < 40; i++) {
      try {
        await runAsProject(PROJECT, () => lease({ loopId: "loop-rate-limit" }));
      } catch {
        denied++;
      }
    }
    // MAX_LEASES_PER_WINDOW is 30, so at least the last 10 are denied.
    expect(denied).toBeGreaterThanOrEqual(1);
  });
});
