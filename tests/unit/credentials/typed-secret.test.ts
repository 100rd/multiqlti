/**
 * typed-secret.test.ts — ADR-003 §D3 Phase 3b typed secret shaping.
 */
import { describe, it, expect } from "vitest";
import { shapeTypedSecret } from "../../../server/credentials/typed-secret.js";

describe("shapeTypedSecret — static", () => {
  it("keys the raw value by the secret name", () => {
    const s = shapeTypedSecret({ name: "MY_TOKEN", type: "static", value: "abc123xyz" });
    expect(s.env).toEqual({ MY_TOKEN: "abc123xyz" });
    expect(s.kubeconfig).toBeUndefined();
    expect(s.scrubExtra).toEqual(["abc123xyz"]);
  });
});

describe("shapeTypedSecret — aws", () => {
  it("maps JSON creds to the standard AWS_* env (full)", () => {
    const value = JSON.stringify({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "s3cretKEYvalue",
      sessionToken: "sessTOKENvalue",
      region: "eu-central-1",
    });
    const s = shapeTypedSecret({ name: "aws-prod", type: "aws", value });
    expect(s.env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "s3cretKEYvalue",
      AWS_SESSION_TOKEN: "sessTOKENvalue",
      AWS_DEFAULT_REGION: "eu-central-1",
    });
    // Region is not secret; key material is scrubbed.
    expect(s.scrubExtra).toContain("s3cretKEYvalue");
    expect(s.scrubExtra).toContain("sessTOKENvalue");
    expect(s.scrubExtra).not.toContain("eu-central-1");
  });

  it("omits optional session token / region when absent", () => {
    const value = JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "secretval" });
    const s = shapeTypedSecret({ name: "aws", type: "aws", value });
    expect(s.env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secretval",
    });
    expect(s.env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(s.env.AWS_DEFAULT_REGION).toBeUndefined();
  });

  it("throws on non-JSON value", () => {
    expect(() =>
      shapeTypedSecret({ name: "aws", type: "aws", value: "not json" }),
    ).toThrow(/not valid JSON/);
  });

  it("throws on a JSON payload missing required fields", () => {
    expect(() =>
      shapeTypedSecret({ name: "aws", type: "aws", value: JSON.stringify({ region: "x" }) }),
    ).toThrow();
  });
});

describe("shapeTypedSecret — kubernetes", () => {
  it("returns the kubeconfig for a per-run temp file (no env var)", () => {
    const kubeconfig = "apiVersion: v1\nkind: Config\n...";
    const s = shapeTypedSecret({ name: "kube-prod", type: "kubernetes", value: kubeconfig });
    expect(s.env).toEqual({});
    expect(s.kubeconfig).toBe(kubeconfig);
    expect(s.scrubExtra).toEqual([kubeconfig]);
  });
});
