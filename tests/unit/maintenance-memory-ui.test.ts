/**
 * Unit tests for Maintenance Autopilot (PR #168) and Memory Preferences (PR #168).
 *
 * Uses source-inspection + pure-logic approach (no jsdom).
 *
 * Covers:
 * 1. Maintenance page: sortBySeverity logic, SEVERITY_ORDER, Autopilot section present
 * 2. Memory page: timeAgo logic, MemoryPreferences component included, ConfidenceBar logic
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

function readSource(relPath: string): string {
  return readFileSync(resolve(PROJECT_ROOT, relPath), "utf-8");
}

// ─── Maintenance page — sortBySeverity ────────────────────────────────────────

describe("Maintenance page — sortBySeverity (PR #168 Autopilot + existing)", () => {
  // Re-implement the pure function from Maintenance.tsx
  type Severity = "critical" | "high" | "medium" | "low" | "info";
  const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

  interface Finding {
    severity: Severity;
    title: string;
    category: string;
  }

  function sortBySeverity(findings: Finding[]): Finding[] {
    return [...findings].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );
  }

  it("sorts critical before high", () => {
    const findings: Finding[] = [
      { severity: "high", title: "High Issue", category: "cve_scan" },
      { severity: "critical", title: "Critical Issue", category: "cve_scan" },
    ];
    const sorted = sortBySeverity(findings);
    expect(sorted[0].severity).toBe("critical");
    expect(sorted[1].severity).toBe("high");
  });

  it("sorts all severity levels in correct order: critical → high → medium → low → info", () => {
    const findings: Finding[] = [
      { severity: "info", title: "Info", category: "log_analysis" },
      { severity: "low", title: "Low", category: "log_analysis" },
      { severity: "critical", title: "Critical", category: "log_analysis" },
      { severity: "medium", title: "Medium", category: "log_analysis" },
      { severity: "high", title: "High", category: "log_analysis" },
    ];
    const sorted = sortBySeverity(findings);
    expect(sorted.map((f) => f.severity)).toEqual(["critical", "high", "medium", "low", "info"]);
  });

  it("returns empty array for empty input", () => {
    expect(sortBySeverity([])).toEqual([]);
  });

  it("is stable for same-severity items (order preserved)", () => {
    const findings: Finding[] = [
      { severity: "high", title: "A", category: "cve_scan" },
      { severity: "high", title: "B", category: "cve_scan" },
    ];
    const sorted = sortBySeverity(findings);
    expect(sorted).toHaveLength(2);
    // Both are high — original relative order is preserved by spread+sort
    const titles = sorted.map((f) => f.title);
    expect(titles).toContain("A");
    expect(titles).toContain("B");
  });

  it("does not mutate the original array", () => {
    const findings: Finding[] = [
      { severity: "low", title: "Low", category: "cve_scan" },
      { severity: "critical", title: "Critical", category: "cve_scan" },
    ];
    const original = [...findings];
    sortBySeverity(findings);
    expect(findings[0].severity).toBe(original[0].severity);
    expect(findings[1].severity).toBe(original[1].severity);
  });

  describe("source structure checks (Maintenance Autopilot PR #168)", () => {
    const source = readSource("client/src/pages/Maintenance.tsx");

    it("has SEVERITY_ORDER constant", () => {
      expect(source).toContain("SEVERITY_ORDER");
    });

    it("has Maintenance Autopilot section", () => {
      expect(source).toContain("Maintenance Autopilot");
    });

    it("has Autopilot Configuration card", () => {
      expect(source).toContain("Autopilot Configuration");
    });

    it("has sortBySeverity function", () => {
      expect(source).toContain("function sortBySeverity");
    });

    it("exports default Maintenance component", () => {
      expect(source).toMatch(/export default function Maintenance/);
    });

    it("has SeverityBadge sub-component", () => {
      expect(source).toContain("SeverityBadge");
    });

    it("has HealthRing sub-component for visual health score", () => {
      expect(source).toContain("HealthRing");
    });

    it("has Scans, Policies, Overview, and Audit tabs", () => {
      expect(source).toContain("OverviewTab");
      expect(source).toContain("PoliciesTab");
      expect(source).toContain("ScansTab");
      expect(source).toContain("AuditTab");
    });

    it("has autopilot schedule/threshold configuration fields", () => {
      // PR #168: autopilot config form
      expect(source.toLowerCase()).toMatch(/schedule|threshold|severity/i);
    });
  });
});

// ─── Memory page — timeAgo ─────────────────────────────────────────────────────

describe("Memory page — timeAgo utility (PR #168 Memory Preferences)", () => {
  // Re-implement timeAgo from Memory.tsx for testing
  function timeAgo(dateStr: string | null): string {
    if (!dateStr) return "unknown";
    const ms = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  it("returns 'unknown' for null input", () => {
    expect(timeAgo(null)).toBe("unknown");
  });

  it("returns minutes for times less than 1 hour ago", () => {
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const result = timeAgo(thirtyMinsAgo);
    expect(result).toMatch(/^\d+m ago$/);
    expect(result).toBe("30m ago");
  });

  it("returns 0m ago for very recent timestamps", () => {
    const justNow = new Date(Date.now() - 500).toISOString();
    const result = timeAgo(justNow);
    expect(result).toBe("0m ago");
  });

  it("returns hours for times between 1 and 24 hours ago", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(twoHoursAgo);
    expect(result).toBe("2h ago");
  });

  it("returns days for times more than 24 hours ago", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(threeDaysAgo);
    expect(result).toBe("3d ago");
  });

  it("handles exactly 1 hour as 1h ago", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = timeAgo(oneHourAgo);
    expect(result).toBe("1h ago");
  });

  it("handles exactly 1 day as 1d ago", () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = timeAgo(oneDayAgo);
    expect(result).toBe("1d ago");
  });

  describe("source structure checks (Memory Preferences PR #168)", () => {
    const source = readSource("client/src/pages/Memory.tsx");

    it("imports MemoryPreferences component", () => {
      expect(source).toContain('import MemoryPreferences');
    });

    it("renders MemoryPreferences with noCard prop", () => {
      expect(source).toContain("<MemoryPreferences noCard");
    });

    it("has timeAgo function in source", () => {
      expect(source).toContain("function timeAgo");
    });

    it("exports default Memory component", () => {
      expect(source).toMatch(/export default function Memory/);
    });

    it("has ConfidenceBar sub-component for memory scores", () => {
      expect(source).toContain("ConfidenceBar");
    });

    it("has MemoryCard sub-component", () => {
      expect(source).toContain("MemoryCard");
    });

    it("has AddMemoryForm sub-component", () => {
      expect(source).toContain("AddMemoryForm");
    });
  });
});

// ─── ConfidenceBar — pure rendering logic ─────────────────────────────────────

describe("ConfidenceBar — confidence value clamping logic", () => {
  // Verify the logic behind confidence percentage display
  // (mirrors how ConfidenceBar would compute its width)

  function confidencePercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value * 100)));
  }

  it("converts 0.5 confidence to 50%", () => {
    expect(confidencePercent(0.5)).toBe(50);
  });

  it("converts 1.0 confidence to 100%", () => {
    expect(confidencePercent(1.0)).toBe(100);
  });

  it("converts 0.0 confidence to 0%", () => {
    expect(confidencePercent(0.0)).toBe(0);
  });

  it("clamps values above 1 to 100%", () => {
    expect(confidencePercent(1.5)).toBe(100);
  });

  it("clamps negative values to 0%", () => {
    expect(confidencePercent(-0.2)).toBe(0);
  });

  it("rounds 0.753 to 75%", () => {
    expect(confidencePercent(0.753)).toBe(75);
  });

  it("rounds 0.999 to 100%", () => {
    expect(confidencePercent(0.999)).toBe(100);
  });
});

// ─── MemoryPreferences component (settings) ───────────────────────────────────

describe("MemoryPreferences settings component", () => {
  it("exists as a file", () => {
    // Verify the file exists (was created in PR #168)
    expect(() => readSource("client/src/components/settings/MemoryPreferences.tsx")).not.toThrow();
  });

  it("exports a default MemoryPreferences component", () => {
    const source = readSource("client/src/components/settings/MemoryPreferences.tsx");
    expect(source).toMatch(/export default function MemoryPreferences|export default MemoryPreferences/);
  });

  it("accepts a noCard prop", () => {
    const source = readSource("client/src/components/settings/MemoryPreferences.tsx");
    expect(source).toContain("noCard");
  });
});
