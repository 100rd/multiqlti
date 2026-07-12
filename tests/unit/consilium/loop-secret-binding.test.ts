/**
 * loop-secret-binding.test.ts — MemStorage loop→secret bound set (ADR-003 §D2).
 *
 * `getLoopSecrets` / `bindLoopSecrets` back the D2 gate in the credential broker's
 * `issueLease` (a credential not in a loop's bound set can never be leased). This
 * asserts the roundtrip, per-(loop, credential) idempotency, empty no-op, and
 * per-loop isolation — WITHOUT a database (MemStorage is fully in-memory).
 *
 * The full `issueLease` gate matrix (D1 run-state, D2 bound-set, rate limit,
 * audit-on-failure) and the create-route 400 mapping query Postgres directly and
 * are covered by the integration suite (tests/integration/credentials-api).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../../server/storage.js";

describe("MemStorage loop→secret bindings (ADR-003 §D2)", () => {
  let storage: MemStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  it("binds and reads back the authorized set for a loop", async () => {
    await storage.bindLoopSecrets({
      loopId: "loop-a",
      credentialIds: ["cred-1", "cred-2"],
      createdBy: "user-1",
    });

    const rows = await storage.getLoopSecrets("loop-a");
    expect(rows.map((r) => r.credentialId).sort()).toEqual(["cred-1", "cred-2"]);
    expect(
      rows.every((r) => r.loopId === "loop-a" && r.createdBy === "user-1"),
    ).toBe(true);
  });

  it("is idempotent per (loop, credential) — re-binding never duplicates", async () => {
    await storage.bindLoopSecrets({
      loopId: "loop-a",
      credentialIds: ["cred-1"],
      createdBy: "u",
    });
    // Re-bind with a duplicate in the batch AND a repeat of the existing pair.
    await storage.bindLoopSecrets({
      loopId: "loop-a",
      credentialIds: ["cred-1", "cred-1", "cred-2"],
      createdBy: "u",
    });

    const rows = await storage.getLoopSecrets("loop-a");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.credentialId).sort()).toEqual(["cred-1", "cred-2"]);
  });

  it("treats an empty credentialIds batch as a no-op", async () => {
    await storage.bindLoopSecrets({
      loopId: "loop-a",
      credentialIds: [],
      createdBy: "u",
    });
    expect(await storage.getLoopSecrets("loop-a")).toHaveLength(0);
  });

  it("isolates bound sets per loop", async () => {
    await storage.bindLoopSecrets({
      loopId: "loop-a",
      credentialIds: ["cred-1"],
      createdBy: "u",
    });
    await storage.bindLoopSecrets({
      loopId: "loop-b",
      credentialIds: ["cred-2"],
      createdBy: "u",
    });

    expect((await storage.getLoopSecrets("loop-a")).map((r) => r.credentialId)).toEqual([
      "cred-1",
    ]);
    expect((await storage.getLoopSecrets("loop-b")).map((r) => r.credentialId)).toEqual([
      "cred-2",
    ]);
    // An unbound loop leases nothing — its set is empty.
    expect(await storage.getLoopSecrets("loop-c")).toHaveLength(0);
  });
});
