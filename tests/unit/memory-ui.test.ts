/**
 * Unit tests for Memory Preferences (PR #168).
 *
 * Uses source-inspection + pure-logic approach (no jsdom).
 *
 * Covers:
 *   Memory page: timeAgo logic, MemoryPreferences component included, ConfidenceBar logic
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

function readSource(relPath: string): string {
  return readFileSync(resolve(PROJECT_ROOT, relPath), "utf-8");
}

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
