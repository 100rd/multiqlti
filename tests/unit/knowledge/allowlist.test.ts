/**
 * Unit tests for the curated source allowlist (SSRF first line of defence).
 *
 * The allowlist is a STRING/HOST gate only — it is paired with safe-fetch's
 * DNS-resolved-IP gate. These tests focus on host-spoofing bypass vectors that
 * the security review flagged as must-cover.
 */
import { describe, it, expect } from "vitest";
import { isAllowedSource } from "../../../server/knowledge/source-allowlist";

describe("isAllowedSource — allowed hosts", () => {
  it("accepts the canonical allowlisted hosts over https", () => {
    expect(isAllowedSource("https://terraform-best-practices.com/")).toBe(true);
    expect(isAllowedSource("https://developer.hashicorp.com/terraform/docs")).toBe(true);
    expect(isAllowedSource("https://opentofu.org/docs/")).toBe(true);
  });

  it("accepts strict subdomains on a dot boundary", () => {
    expect(isAllowedSource("https://www.opentofu.org/docs")).toBe(true);
  });

  it("accepts path-scoped github repos", () => {
    expect(isAllowedSource("https://github.com/hashicorp/terraform/blob/main/CHANGELOG.md")).toBe(true);
    expect(isAllowedSource("https://github.com/opentofu/opentofu/releases")).toBe(true);
  });

  it("is case-insensitive on the host", () => {
    expect(isAllowedSource("https://DEVELOPER.HashiCorp.COM/terraform")).toBe(true);
  });
});

describe("isAllowedSource — rejected vectors", () => {
  it("rejects non-https schemes", () => {
    expect(isAllowedSource("http://developer.hashicorp.com/")).toBe(false);
    expect(isAllowedSource("ftp://opentofu.org/")).toBe(false);
    expect(isAllowedSource("file:///etc/passwd")).toBe(false);
    expect(isAllowedSource("gopher://opentofu.org/")).toBe(false);
  });

  it("rejects suffix-spoof: allowed host as a left label of an evil domain", () => {
    expect(isAllowedSource("https://developer.hashicorp.com.evil.com/")).toBe(false);
    expect(isAllowedSource("https://opentofu.org.attacker.net/")).toBe(false);
  });

  it("rejects non-dot-boundary suffix matches", () => {
    expect(isAllowedSource("https://notopentofu.org/")).toBe(false);
    expect(isAllowedSource("https://evilterraform-best-practices.com/")).toBe(false);
  });

  it("rejects userinfo@ host smuggling", () => {
    expect(isAllowedSource("https://developer.hashicorp.com@evil.com/")).toBe(false);
    expect(isAllowedSource("https://user:pass@evil.com/")).toBe(false);
  });

  it("rejects fragment/userinfo confusion", () => {
    expect(isAllowedSource("https://evil.com#@developer.hashicorp.com")).toBe(false);
  });

  it("rejects embedded explicit ports", () => {
    expect(isAllowedSource("https://developer.hashicorp.com:8443/")).toBe(false);
    expect(isAllowedSource("https://opentofu.org:1337/")).toBe(false);
  });

  it("rejects punycode / IDN / non-ASCII host spoofs", () => {
    // xn-- ACE prefix
    expect(isAllowedSource("https://xn--developer-hashicorp.com/")).toBe(false);
    // cyrillic homoglyph 'о' (U+043E) in opentofu
    expect(isAllowedSource("https://оpentofu.org/")).toBe(false);
  });

  it("rejects null byte / space injected into the host position", () => {
    // A space or null byte in the host makes the host non-allowlisted/unparseable.
    expect(isAllowedSource("https://opentofu.org%00.evil.com")).toBe(false);
    expect(isAllowedSource("https://opentofu .org/")).toBe(false);
  });

  it("rejects bare IP literals even if 'allowed' shaped", () => {
    expect(isAllowedSource("https://127.0.0.1/")).toBe(false);
    expect(isAllowedSource("https://169.254.169.254/")).toBe(false);
  });

  it("rejects github.com paths outside the scoped repos", () => {
    expect(isAllowedSource("https://github.com/evil/malware")).toBe(false);
    expect(isAllowedSource("https://github.com/hashicorp/vault")).toBe(false);
  });

  it("rejects garbage / unparseable input", () => {
    expect(isAllowedSource("not a url")).toBe(false);
    expect(isAllowedSource("")).toBe(false);
    expect(isAllowedSource("https://")).toBe(false);
  });
});
