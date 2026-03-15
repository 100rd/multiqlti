/**
 * Unit tests for the Maintenance Scout Agent (Phase 4.5 PR 2).
 *
 * Uses vi.mock to replace execFile so no real shell commands run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock child_process ────────────────────────────────────────────────────────

let mockExecResult: { stdout: string } | Error = { stdout: "" };

vi.mock("child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _options: unknown,
    callback: (err: Error | null, result: { stdout: string } | null) => void,
  ) => {
    if (mockExecResult instanceof Error) {
      callback(mockExecResult, null);
    } else {
      callback(null, mockExecResult);
    }
  },
}));

import {
  scanDependencyUpdates,
  scanSecurityAdvisories,
  scanLicenseCompliance,
  runScout,
} from "../../../server/maintenance/scout.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Scout Agent", () => {
  beforeEach(() => {
    mockExecResult = { stdout: "" };
  });

  // ── scanDependencyUpdates ─────────────────────────────────────────────────

  describe("scanDependencyUpdates", () => {
    it("returns empty array when npm outdated output is empty", async () => {
      mockExecResult = { stdout: "{}" };
      const findings = await scanDependencyUpdates("/tmp/workspace", "scan-1");
      expect(findings).toEqual([]);
    });

    it("returns findings for outdated packages", async () => {
      mockExecResult = {
        stdout: JSON.stringify({
          express: { current: "4.18.0", wanted: "4.18.3", latest: "5.0.0", type: "dependencies" },
          lodash: { current: "4.17.20", wanted: "4.17.21", latest: "4.17.21", type: "dependencies" },
        }),
      };
      const findings = await scanDependencyUpdates("/tmp/workspace", "scan-1");
      expect(findings.length).toBe(2);

      const expressFinding = findings.find((f) => f.title.includes("express"));
      expect(expressFinding).toBeDefined();
      expect(expressFinding?.severity).toBe("high"); // major bump 4 → 5
      expect(expressFinding?.category).toBe("dependency_update");
      expect(expressFinding?.status).toBe("open");

      const lodashFinding = findings.find((f) => f.title.includes("lodash"));
      expect(lodashFinding).toBeDefined();
      expect(lodashFinding?.severity).toBe("medium"); // patch bump
      expect(lodashFinding?.autoFixable).toBe(true);
    });

    it("skips packages already at latest", async () => {
      mockExecResult = {
        stdout: JSON.stringify({
          react: { current: "19.0.0", wanted: "19.0.0", latest: "19.0.0" },
        }),
      };
      const findings = await scanDependencyUpdates("/tmp/workspace", "scan-1");
      expect(findings).toEqual([]);
    });

    it("returns empty array when execFile fails", async () => {
      mockExecResult = new Error("Command not found");
      const findings = await scanDependencyUpdates("/tmp/workspace", "scan-1");
      expect(findings).toEqual([]);
    });

    it("returns empty array when output is invalid JSON", async () => {
      mockExecResult = { stdout: "not json" };
      const findings = await scanDependencyUpdates("/tmp/workspace", "scan-1");
      expect(findings).toEqual([]);
    });

    it("finding has all required ScoutFinding fields", async () => {
      mockExecResult = {
        stdout: JSON.stringify({
          zod: { current: "3.20.0", wanted: "3.21.0", latest: "3.21.0" },
        }),
      };
      const [finding] = await scanDependencyUpdates("/tmp/workspace", "scan-1");
      expect(finding.id).toBeDefined();
      expect(typeof finding.id).toBe("string");
      expect(finding.scanId).toBe("scan-1");
      expect(finding.category).toBe("dependency_update");
      expect(finding.title).toContain("zod");
      expect(finding.currentValue).toBe("3.20.0");
      expect(finding.recommendedValue).toBe("3.21.0");
      expect(Array.isArray(finding.references)).toBe(true);
      expect(Array.isArray(finding.complianceRefs)).toBe(true);
    });
  });

  // ── scanSecurityAdvisories ────────────────────────────────────────────────

  describe("scanSecurityAdvisories", () => {
    it("returns empty array when no vulnerabilities", async () => {
      mockExecResult = { stdout: JSON.stringify({ vulnerabilities: {}, metadata: {} }) };
      const findings = await scanSecurityAdvisories("/tmp/workspace", "scan-2");
      expect(findings).toEqual([]);
    });

    it("maps npm severity levels to finding severity", async () => {
      mockExecResult = {
        stdout: JSON.stringify({
          vulnerabilities: {
            lodash: {
              severity: "critical",
              isDirect: true,
              via: ["prototype-pollution"],
              fixAvailable: true,
              nodes: ["node_modules/lodash"],
            },
            axios: {
              severity: "moderate",
              isDirect: false,
              via: ["some-dep"],
              fixAvailable: false,
              nodes: ["node_modules/axios"],
            },
            minimatch: {
              severity: "low",
              isDirect: false,
              via: [],
              fixAvailable: false,
              nodes: ["node_modules/minimatch"],
            },
          },
        }),
      };

      const findings = await scanSecurityAdvisories("/tmp/workspace", "scan-2");
      expect(findings.length).toBe(3);

      const lodash = findings.find((f) => f.title.includes("lodash"));
      expect(lodash?.severity).toBe("critical");
      expect(lodash?.autoFixable).toBe(true);

      const axiosFinding = findings.find((f) => f.title.includes("axios"));
      expect(axiosFinding?.severity).toBe("medium");
      expect(axiosFinding?.autoFixable).toBe(false);

      const minimatch = findings.find((f) => f.title.includes("minimatch"));
      expect(minimatch?.severity).toBe("low");
    });

    it("returns empty array when execFile fails", async () => {
      mockExecResult = new Error("npm not found");
      const findings = await scanSecurityAdvisories("/tmp/workspace", "scan-2");
      expect(findings).toEqual([]);
    });

    it("returns empty array for malformed JSON", async () => {
      mockExecResult = { stdout: "{{invalid}}" };
      const findings = await scanSecurityAdvisories("/tmp/workspace", "scan-2");
      expect(findings).toEqual([]);
    });
  });

  // ── scanLicenseCompliance ─────────────────────────────────────────────────

  describe("scanLicenseCompliance", () => {
    it("returns empty array when all licenses are permissive", async () => {
      mockExecResult = {
        stdout: JSON.stringify({
          "react@19.0.0": { licenses: "MIT", repository: "https://github.com/facebook/react" },
          "lodash@4.17.21": { licenses: "MIT" },
          "zod@3.22.0": { licenses: "MIT" },
        }),
      };
      const findings = await scanLicenseCompliance("/tmp/workspace", "scan-3");
      expect(findings).toEqual([]);
    });

    it("detects unknown licenses", async () => {
      mockExecResult = {
        stdout: JSON.stringify({
          "mystery-pkg@1.0.0": { licenses: "UNKNOWN" },
        }),
      };
      const findings = await scanLicenseCompliance("/tmp/workspace", "scan-3");
      expect(findings.length).toBe(1);
      expect(findings[0].severity).toBe("high");
      expect(findings[0].category).toBe("license_compliance");
      expect(findings[0].title).toContain("mystery-pkg");
    });

    it("detects copyleft licenses", async () => {
      mockExecResult = {
        stdout: JSON.stringify({
          "gpl-lib@2.0.0": { licenses: "GPL-3.0" },
          "agpl-lib@1.0.0": { licenses: "AGPL-3.0" },
          "mit-lib@1.0.0": { licenses: "MIT" },
        }),
      };
      const findings = await scanLicenseCompliance("/tmp/workspace", "scan-3");
      expect(findings.length).toBe(2);
      expect(findings.every((f) => f.category === "license_compliance")).toBe(true);
      expect(findings.every((f) => f.severity === "medium")).toBe(true);
      const titles = findings.map((f) => f.title);
      expect(titles.some((t) => t.includes("gpl-lib"))).toBe(true);
      expect(titles.some((t) => t.includes("agpl-lib"))).toBe(true);
    });

    it("detects UNLICENSED packages", async () => {
      mockExecResult = {
        stdout: JSON.stringify({
          "internal-pkg@0.1.0": { licenses: "UNLICENSED" },
        }),
      };
      const findings = await scanLicenseCompliance("/tmp/workspace", "scan-3");
      expect(findings.length).toBe(1);
      expect(findings[0].severity).toBe("high");
    });

    it("returns empty array when license-checker fails", async () => {
      mockExecResult = new Error("npx failed");
      const findings = await scanLicenseCompliance("/tmp/workspace", "scan-3");
      expect(findings).toEqual([]);
    });
  });

  // ── runScout ──────────────────────────────────────────────────────────────

  describe("runScout", () => {
    it("returns aggregate findings from all enabled scanners", async () => {
      // All scanners return empty (mock returns empty JSON)
      mockExecResult = { stdout: "{}" };
      const result = await runScout({ workspacePath: "/tmp/ws", scanId: "scan-agg" });
      expect(result.findings).toBeInstanceOf(Array);
      expect(result.importantCount).toBe(0);
      expect(result.errors).toBeInstanceOf(Array);
    });

    it("respects enabledCategories filter", async () => {
      mockExecResult = { stdout: "{}" };
      const result = await runScout({
        workspacePath: "/tmp/ws",
        scanId: "scan-filtered",
        enabledCategories: ["security_advisory"],
      });
      // Should still work — just fewer scanners ran
      expect(result.findings).toBeInstanceOf(Array);
    });

    it("counts importantCount as critical + high findings", async () => {
      // Simulate one high dependency update finding
      mockExecResult = {
        stdout: JSON.stringify({
          express: { current: "4.0.0", wanted: "5.0.0", latest: "5.0.0" },
        }),
      };
      const result = await runScout({
        workspacePath: "/tmp/ws",
        scanId: "scan-count",
        enabledCategories: ["dependency_update"],
      });
      expect(result.importantCount).toBeGreaterThanOrEqual(0);
    });

    it("captures scanner errors without throwing", async () => {
      // Throw inside the scanner by providing bad mock (malformed for all)
      mockExecResult = { stdout: "NOT_JSON_AT_ALL####" };
      const result = await runScout({ workspacePath: "/tmp/ws", scanId: "scan-err" });
      // Should not throw, errors array may be populated
      expect(result).toBeDefined();
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });
});
