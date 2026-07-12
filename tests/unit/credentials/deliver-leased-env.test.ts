/**
 * deliver-leased-env.test.ts — ADR-003 Phase 3a.C delivery helper.
 *
 * Verifies the exec-time delivery contract with a fake broker + storage:
 *   - no bound secrets ⇒ empty result, NO lease issued (byte-identical spawn);
 *   - bound secrets ⇒ env keyed by secret NAME, values + leaseIds collected,
 *     one issueLease + one getSecretValue per bound credential;
 *   - a credential removed since binding (no metadata name) is skipped;
 *   - a mid-loop failure revokes the leases already issued, then rethrows
 *     (no orphaned active lease).
 */
import { describe, it, expect, vi } from "vitest";
import { deliverLeasedEnv } from "../../../server/credentials/deliver-leased-env.js";
import type { CredentialProvider } from "../../../server/credentials/types.js";

type BoundRow = {
  loopId: string;
  credentialId: string;
  createdBy: string;
  createdAt: Date;
};

function fakeStorage(rows: BoundRow[]) {
  return {
    getLoopSecrets: vi.fn(async (loopId: string) =>
      rows.filter((r) => r.loopId === loopId),
    ),
  };
}

function fakeProvider(over: Partial<CredentialProvider> = {}): CredentialProvider {
  return {
    listCredentials: vi.fn(async () => [
      { id: "cred-1", name: "AWS_KEY" },
      { id: "cred-2", name: "KUBE" },
    ]),
    getCredentialMetadata: vi.fn(),
    accessSecret: vi.fn(),
    getSecretValue: vi.fn(async (q: { credentialId: string }) => `value-of-${q.credentialId}`),
    issueLease: vi.fn(async (q: { credentialId: string }) => ({
      leaseId: `lease-${q.credentialId}`,
      expiresAt: new Date(0),
    })),
    revokeLease: vi.fn(async () => undefined),
    revokeRunLeases: vi.fn(async () => undefined),
    putCredential: vi.fn(),
    deleteCredential: vi.fn(),
    ...over,
  } as unknown as CredentialProvider;
}

const base = {
  projectId: "p",
  loopId: "loop-a",
  phase: "developing",
  requestedBy: "user-1",
};

describe("deliverLeasedEnv (ADR-003 §3a.C)", () => {
  it("returns empty and issues no lease when the loop has no bound secrets", async () => {
    const provider = fakeProvider();
    const storage = fakeStorage([]);

    const out = await deliverLeasedEnv({ provider, storage, ...base });

    expect(out).toEqual({ env: {}, values: [], leaseIds: [] });
    expect(provider.issueLease).not.toHaveBeenCalled();
    expect(provider.getSecretValue).not.toHaveBeenCalled();
  });

  it("issues a lease + delivers env keyed by secret name for each bound secret", async () => {
    const provider = fakeProvider();
    const storage = fakeStorage([
      { loopId: "loop-a", credentialId: "cred-1", createdBy: "u", createdAt: new Date(0) },
      { loopId: "loop-a", credentialId: "cred-2", createdBy: "u", createdAt: new Date(0) },
    ]);

    const out = await deliverLeasedEnv({ provider, storage, ...base });

    expect(out.env).toEqual({ AWS_KEY: "value-of-cred-1", KUBE: "value-of-cred-2" });
    expect(out.values.sort()).toEqual(["value-of-cred-1", "value-of-cred-2"]);
    expect(out.leaseIds.sort()).toEqual(["lease-cred-1", "lease-cred-2"]);
    expect(provider.issueLease).toHaveBeenCalledTimes(2);
    expect(provider.getSecretValue).toHaveBeenCalledTimes(2);
  });

  it("skips a credential removed since binding (no metadata name)", async () => {
    const provider = fakeProvider({
      listCredentials: vi.fn(async () => [{ id: "cred-1", name: "AWS_KEY" }]),
    });
    const storage = fakeStorage([
      { loopId: "loop-a", credentialId: "cred-1", createdBy: "u", createdAt: new Date(0) },
      { loopId: "loop-a", credentialId: "cred-2", createdBy: "u", createdAt: new Date(0) },
    ]);

    const out = await deliverLeasedEnv({ provider, storage, ...base });

    expect(out.env).toEqual({ AWS_KEY: "value-of-cred-1" });
    expect(out.leaseIds).toEqual(["lease-cred-1"]);
    expect(provider.issueLease).toHaveBeenCalledTimes(1);
  });

  it("revokes already-issued leases and rethrows on a mid-loop failure", async () => {
    const provider = fakeProvider({
      // Second secret's value decrypt fails after both leases were issued.
      getSecretValue: vi
        .fn()
        .mockResolvedValueOnce("value-of-cred-1")
        .mockRejectedValueOnce(new Error("decrypt boom")),
    });
    const storage = fakeStorage([
      { loopId: "loop-a", credentialId: "cred-1", createdBy: "u", createdAt: new Date(0) },
      { loopId: "loop-a", credentialId: "cred-2", createdBy: "u", createdAt: new Date(0) },
    ]);

    await expect(deliverLeasedEnv({ provider, storage, ...base })).rejects.toThrow(
      "decrypt boom",
    );
    // Both leases were issued before the failure; both must be revoked.
    expect(provider.revokeLease).toHaveBeenCalledWith("lease-cred-1");
    expect(provider.revokeLease).toHaveBeenCalledWith("lease-cred-2");
  });
});
