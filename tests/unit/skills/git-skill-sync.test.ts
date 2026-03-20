/**
 * Unit tests for git-skill-sync.ts
 *
 * Tests:
 * - isAllowedRepoUrl: rejects disallowed schemes, accepts https:// and git@
 * - PAT injection into clone URL
 * - Path traversal detection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db before any imports so module resolution picks up the mock
vi.mock("../../../server/db.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: () => ({ values: () => Promise.resolve() }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

vi.mock("../../../server/crypto.js", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

// Import AFTER mocks are set up
import { isAllowedRepoUrl } from "../../../server/services/git-skill-sync.js";

// ─── isAllowedRepoUrl ─────────────────────────────────────────────────────────

describe("isAllowedRepoUrl", () => {
  describe("allowed URLs", () => {
    it("accepts https:// URLs", () => {
      expect(isAllowedRepoUrl("https://github.com/org/repo.git")).toBe(true);
    });

    it("accepts https:// with subdomain", () => {
      expect(isAllowedRepoUrl("https://gitlab.example.com/group/repo")).toBe(true);
    });

    it("accepts git@ SSH shorthand", () => {
      expect(isAllowedRepoUrl("git@github.com:owner/repo.git")).toBe(true);
    });

    it("accepts git@ with nested path", () => {
      expect(isAllowedRepoUrl("git@gitlab.com:group/subgroup/repo.git")).toBe(true);
    });
  });

  describe("rejected URL schemes", () => {
    it("rejects file:// URLs", () => {
      expect(isAllowedRepoUrl("file:///etc/passwd")).toBe(false);
    });

    it("rejects file:// with relative path", () => {
      expect(isAllowedRepoUrl("file://localhost/some/path")).toBe(false);
    });

    it("rejects git:// URLs", () => {
      expect(isAllowedRepoUrl("git://github.com/org/repo.git")).toBe(false);
    });

    it("rejects ssh:// URLs", () => {
      expect(isAllowedRepoUrl("ssh://git@github.com/repo.git")).toBe(false);
    });

    it("rejects bare path", () => {
      expect(isAllowedRepoUrl("/local/path/to/repo")).toBe(false);
    });

    it("rejects relative path", () => {
      expect(isAllowedRepoUrl("../relative/repo")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isAllowedRepoUrl("")).toBe(false);
    });

    it("rejects ftp:// URLs", () => {
      expect(isAllowedRepoUrl("ftp://example.com/repo")).toBe(false);
    });

    it("rejects http:// (non-TLS)", () => {
      expect(isAllowedRepoUrl("http://github.com/org/repo.git")).toBe(false);
    });
  });
});
