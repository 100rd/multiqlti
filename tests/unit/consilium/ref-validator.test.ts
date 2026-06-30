/**
 * ref-validator.test.ts — the strict branch/revision validator that gates a
 * BRANCH-targeted consilium review's `ref` BEFORE it reaches git
 * (server/services/consilium/ref-validator.ts).
 *
 * SECURITY: this is the boundary the adversarial reviewer cares about — the ref
 * eventually reaches git (diff-context HEAD resolution + embedSpecSetAtRef) as an
 * arg-array element. These cases prove option-injection (`-x`), range/peel
 * syntax (`a..b`, `x@{1}`, `HEAD~1`, `ref:path`), shell metachars, empty, and
 * overlong refs are all REJECTED, while ordinary branch names are accepted.
 */
import { describe, it, expect } from "vitest";
import {
  validateReviewRef,
  REVIEW_REF_RE,
  INVALID_REF_MESSAGE,
} from "../../../server/services/consilium/ref-validator.js";

describe("validateReviewRef — accepts ordinary branch/revision names", () => {
  const valid = [
    "feature/x",
    "main",
    "develop",
    "release/1.2.3",
    "feat_foo-bar",
    "users/jane/topic",
    "v1.0.0",
    "a",
    "a".repeat(255), // exactly the cap
    "renovate/lock-file-maintenance",
    "0123456789abcdef0123456789abcdef01234567", // a full sha is also a valid rev
  ];
  for (const ref of valid) {
    it(`accepts ${JSON.stringify(ref.length > 24 ? ref.slice(0, 12) + "…" : ref)}`, () => {
      expect(validateReviewRef(ref)).toBe(ref);
      expect(REVIEW_REF_RE.test(ref)).toBe(true);
    });
  }
});

describe("validateReviewRef — rejects unsafe / malformed refs (SECURITY)", () => {
  const bad: Record<string, string> = {
    "leading dash (flag injection)": "-x",
    "leading double-dash (long flag)": "--upload-pack=evil",
    "double-dot range syntax": "a..b",
    "reflog/upstream peel @{": "x@{1}",
    "tilde rev navigation": "HEAD~1",
    "caret rev navigation": "HEAD^2",
    "colon path peel": "ref:path/to/file",
    "empty string": "",
    "overlong (256)": "a".repeat(256),
    "shell: semicolon + rm": "main; rm -rf /",
    "shell: command substitution": "$(whoami)",
    "shell: backticks": "`id`",
    "shell: pipe": "a|b",
    "shell: ampersand": "a&b",
    "shell: redirect": "a>b",
    "embedded space": "feature x",
    "embedded newline": "a\nb",
    "embedded tab": "a\tb",
    "null byte": "a\u0000b",
    "at-brace upstream": "@{upstream}",
    "glob star": "feat/*",
    "backslash": "a\\b",
    "quote": "a'b",
    // LOW-2: tightened — absolute-path-shaped + all-dots/slashes refs now rejected.
    "leading slash (absolute path)": "/etc/passwd",
    "leading slash bare": "/foo",
    "single dot (no alnum)": ".",
    "bare slash (no alnum)": "/",
    "all dots/slashes (no alnum)": "./.",
    "underscore only (no alnum)": "_",
    "dash-slash (no alnum, leading dash)": "-/-",
  };
  for (const [name, ref] of Object.entries(bad)) {
    it(`rejects ${name}`, () => {
      expect(() => validateReviewRef(ref)).toThrow(INVALID_REF_MESSAGE);
      expect(REVIEW_REF_RE.test(ref)).toBe(false);
    });
  }

  it("rejects a non-string input", () => {
    expect(() => validateReviewRef(undefined)).toThrow(INVALID_REF_MESSAGE);
    expect(() => validateReviewRef(null)).toThrow(INVALID_REF_MESSAGE);
    expect(() => validateReviewRef(123 as unknown)).toThrow(INVALID_REF_MESSAGE);
  });

  it("LOW-2: leading-slash & all-dot/slash refs rejected, ordinary nested refs still accepted", () => {
    // newly rejected
    for (const bad of ["/etc/passwd", "/foo", ".", "/", "./.", "_"]) {
      expect(REVIEW_REF_RE.test(bad)).toBe(false);
    }
    // still accepted (regression guard)
    for (const ok of ["feature/x", "release/1.2.3", "main"]) {
      expect(REVIEW_REF_RE.test(ok)).toBe(true);
      expect(validateReviewRef(ok)).toBe(ok);
    }
  });

  it("the 255-char cap is exact (255 ok, 256 rejected)", () => {
    expect(REVIEW_REF_RE.test("a".repeat(255))).toBe(true);
    expect(REVIEW_REF_RE.test("a".repeat(256))).toBe(false);
  });
});
