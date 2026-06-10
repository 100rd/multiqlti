/**
 * Q3 allowlist widening (Security APPROVED WITH CONSTRAINTS).
 *
 * Asserts the curated research hosts/prefixes are accepted through the SAME
 * isAllowedSource gate — and that all the prior SSRF protections still hold:
 * github stays path-scoped (NO host-level github), punycode/port/userinfo/http/
 * non-ascii still rejected.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect } from "vitest";
import { isAllowedSource } from "../../../server/knowledge/source-allowlist.js";

describe("source-allowlist — Q3 research widening (allowed)", () => {
  it("allows curated github org/repo path prefixes", () => {
    expect(isAllowedSource("https://github.com/hashicorp/terraform")).toBe(true);
    expect(isAllowedSource("https://github.com/aws-samples/some-repo")).toBe(true);
    expect(isAllowedSource("https://github.com/kubernetes/kubernetes/blob/main/README.md")).toBe(
      true,
    );
    expect(isAllowedSource("https://github.com/opentofu/opentofu")).toBe(true);
  });

  it("allows medium.com host-level (and its subdomains)", () => {
    expect(isAllowedSource("https://medium.com/some-article")).toBe(true);
    expect(isAllowedSource("https://blog.medium.com/x")).toBe(true);
  });
});

describe("source-allowlist — Q3 widening keeps SSRF protections (rejected)", () => {
  it("rejects host-level github.com (no path scope)", () => {
    expect(isAllowedSource("https://github.com/")).toBe(false);
    expect(isAllowedSource("https://github.com/random-untrusted-org/evil")).toBe(false);
  });

  it("L-GH-1: rejects look-alike orgs that only prefix a curated org name", () => {
    // The gate matches `prefix` or `prefix + "/"`, so `kubernetes-evil` must NOT
    // satisfy the `/kubernetes` prefix.
    expect(isAllowedSource("https://github.com/kubernetes-evil/x")).toBe(false);
    expect(isAllowedSource("https://github.com/hashicorp-evil/x")).toBe(false);
    expect(isAllowedSource("https://github.com/aws-samples-evil/x")).toBe(false);
    expect(isAllowedSource("https://github.com/opentofu-evil/x")).toBe(false);
  });

  it("rejects http (non-https) for a research host", () => {
    expect(isAllowedSource("http://medium.com/x")).toBe(false);
  });

  it("rejects explicit ports", () => {
    expect(isAllowedSource("https://medium.com:8443/x")).toBe(false);
    expect(isAllowedSource("https://github.com:8443/hashicorp/terraform")).toBe(false);
  });

  it("rejects userinfo (credential smuggling)", () => {
    expect(isAllowedSource("https://user:pass@medium.com/x")).toBe(false);
  });

  it("rejects punycode / non-ascii homoglyph hosts", () => {
    expect(isAllowedSource("https://xn--medium-x.com/x")).toBe(false);
    expect(isAllowedSource("https://mеdium.com/x")).toBe(false); // cyrillic 'е'
  });

  it("rejects a lookalike host that is not a dot-boundary subdomain", () => {
    expect(isAllowedSource("https://notmedium.com/x")).toBe(false);
    expect(isAllowedSource("https://medium.com.evil.com/x")).toBe(false);
  });
});
