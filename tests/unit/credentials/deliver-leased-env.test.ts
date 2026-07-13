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
import { readFile, stat } from "node:fs/promises";
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

describe("deliverLeasedEnv — typed delivery (ADR-003 §3b)", () => {
  const one = { loopId: "loop-a", credentialId: "cred-1", createdBy: "u", createdAt: new Date(0) };

  it("shapes an aws secret into the AWS_* env vars", async () => {
    const provider = fakeProvider({
      listCredentials: vi.fn(async () => [{ id: "cred-1", name: "aws-prod", type: "aws" }]),
      getSecretValue: vi.fn(async () =>
        JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "secretval", region: "eu-central-1" }),
      ),
    });
    const out = await deliverLeasedEnv({ provider, storage: fakeStorage([one]), ...base });
    expect(out.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secretval",
      AWS_DEFAULT_REGION: "eu-central-1",
    });
    expect(out.values).toContain("secretval");
    await out.cleanup();
  });

  it("writes a kubernetes secret to a 0600 temp file + KUBECONFIG, removed by cleanup()", async () => {
    const kubeconfig = "apiVersion: v1\nkind: Config";
    const provider = fakeProvider({
      listCredentials: vi.fn(async () => [{ id: "cred-1", name: "kube", type: "kubernetes" }]),
      getSecretValue: vi.fn(async () => kubeconfig),
    });
    const out = await deliverLeasedEnv({ provider, storage: fakeStorage([one]), ...base });
    const path = out.env.KUBECONFIG;
    expect(path).toBeTruthy();
    expect(await readFile(path, "utf8")).toBe(kubeconfig);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(out.values).toContain(kubeconfig);
    await out.cleanup();
    await expect(stat(path)).rejects.toThrow(); // removed
  });

  it("fail-soft: drops a malformed aws secret (empty env), lease still issued", async () => {
    const provider = fakeProvider({
      listCredentials: vi.fn(async () => [{ id: "cred-1", name: "aws", type: "aws" }]),
      getSecretValue: vi.fn(async () => "not json"),
    });
    const out = await deliverLeasedEnv({ provider, storage: fakeStorage([one]), ...base });
    expect(out.env).toEqual({});
    expect(out.leaseIds).toHaveLength(1);
    await out.cleanup();
  });

  it("static (no type) is byte-identical — env keyed by name", async () => {
    const provider = fakeProvider({
      listCredentials: vi.fn(async () => [{ id: "cred-1", name: "TOK" }]),
      getSecretValue: vi.fn(async () => "rawtoken"),
    });
    const out = await deliverLeasedEnv({ provider, storage: fakeStorage([one]), ...base });
    expect(out.env).toEqual({ TOK: "rawtoken" });
    await out.cleanup();
  });
});

describe("deliverLeasedEnv (ADR-003 §3a.C)", () => {
  it("returns empty and issues no lease when the loop has no bound secrets", async () => {
    const provider = fakeProvider();
    const storage = fakeStorage([]);

    const out = await deliverLeasedEnv({ provider, storage, ...base });

    expect(out.env).toEqual({});
    expect(out.values).toEqual([]);
    expect(out.leaseIds).toEqual([]);
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
