/**
 * Unit tests for parseBranchFromUrl — the pure helper backing the "paste a branch
 * URL / custom ref" affordance on the New consilium review dialog.
 *
 * Cases (per the task): a GitHub tree URL, a GitLab `-/tree` URL, a branch with
 * slashes (release/1.2) via BOTH a URL and a bare ref, a bare-ref passthrough, and
 * trailing junk (query / hash / trailing slash). Plus empty / whitespace guards.
 */
import { describe, it, expect } from "vitest";
import { parseBranchFromUrl } from "@/components/consilium/parse-branch-url";

describe("parseBranchFromUrl", () => {
  it("extracts the ref from a GitHub tree URL", () => {
    expect(parseBranchFromUrl("https://github.com/owner/repo/tree/main")).toBe(
      "main",
    );
  });

  it("extracts the ref from a GitLab `-/tree` URL", () => {
    expect(
      parseBranchFromUrl("https://gitlab.com/group/project/-/tree/main"),
    ).toBe("main");
  });

  it("preserves a slash-containing ref from a GitHub tree URL", () => {
    expect(
      parseBranchFromUrl("https://github.com/owner/repo/tree/release/1.2"),
    ).toBe("release/1.2");
  });

  it("preserves a slash-containing ref from a GitLab `-/tree` URL", () => {
    expect(
      parseBranchFromUrl("https://gitlab.com/group/project/-/tree/release/1.2"),
    ).toBe("release/1.2");
  });

  it("passes a bare slash-containing ref through unchanged", () => {
    expect(parseBranchFromUrl("release/1.2")).toBe("release/1.2");
  });

  it("passes a bare simple ref through unchanged", () => {
    expect(parseBranchFromUrl("main")).toBe("main");
  });

  it("strips a trailing query string from a tree URL", () => {
    expect(
      parseBranchFromUrl("https://github.com/owner/repo/tree/main?tab=readme"),
    ).toBe("main");
  });

  it("strips a trailing hash fragment from a tree URL", () => {
    expect(
      parseBranchFromUrl("https://github.com/owner/repo/tree/main#section"),
    ).toBe("main");
  });

  it("strips a trailing slash from a tree URL", () => {
    expect(parseBranchFromUrl("https://github.com/owner/repo/tree/main/")).toBe(
      "main",
    );
  });

  it("strips trailing junk while keeping a slash-containing ref", () => {
    expect(
      parseBranchFromUrl(
        "https://gitlab.com/group/project/-/tree/release/1.2?ref_type=heads",
      ),
    ).toBe("release/1.2");
  });

  it("decodes a percent-encoded ref segment", () => {
    expect(
      parseBranchFromUrl("https://github.com/owner/repo/tree/feature%2Fauth"),
    ).toBe("feature/auth");
  });

  it("trims surrounding whitespace from a bare ref", () => {
    expect(parseBranchFromUrl("  develop  ")).toBe("develop");
  });

  it("returns an empty string for empty / whitespace-only input", () => {
    expect(parseBranchFromUrl("")).toBe("");
    expect(parseBranchFromUrl("   ")).toBe("");
  });
});
