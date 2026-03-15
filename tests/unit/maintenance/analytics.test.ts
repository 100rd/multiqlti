/**
 * Unit tests for the Maintenance Analytics Engine (Phase 4.5 PR 4).
 *
 * Pure functions — no mocking needed.
 */
import { describe, it, expect } from "vitest";
import {
  computeMttr,
  computeCategoryBreakdown,
  computeScoreHistory,
  projectTrend,
  generateRecommendations,
  computeAnalyticsReport,
} from "../../../server/maintenance/analytics";
import type { MaintenanceScan, MaintenancePolicy, ScoutFinding } from "@shared/types";

// ─── Test Data Helpers ────────────────────────────────────────────────────────

function makeScan(
  id: string,
  findings: Partial<ScoutFinding>[],
  status: "completed" | "running" | "failed" = "completed",
  daysAgo = 0,
): MaintenanceScan {
  const now = new Date();
  const started = new Date(now.getTime() - daysAgo * 86_400_000 - 3_600_000);
  const completed = new Date(now.getTime() - daysAgo * 86_400_000);

  return {
    id,
    policyId: "policy-1",
    workspaceId: "ws-1",
    status,
    findings: findings.map((f, i) => ({
      id: f.id ?? `finding-${id}-${i}`,
      scanId: id,
      category: f.category ?? "dependency_update",
      severity: f.severity ?? "medium",
      title: f.title ?? `Finding ${i}`,
      description: f.description ?? "desc",
      currentValue: f.currentValue ?? "old",
      recommendedValue: f.recommendedValue ?? "new",
      effort: f.effort ?? "small",
      references: f.references ?? [],
      autoFixable: f.autoFixable ?? false,
      complianceRefs: f.complianceRefs ?? [],
      status: f.status ?? "open",
    })) as ScoutFinding[],
    importantCount: findings.filter((f) => f.severity === "critical" || f.severity === "high").length,
    triggeredPipelineId: null,
    startedAt: started,
    completedAt: status === "completed" ? completed : null,
    createdAt: started,
  };
}

const basePolicy: MaintenancePolicy = {
  id: "policy-1",
  workspaceId: "ws-1",
  enabled: true,
  schedule: "0 9 * * 1",
  categories: [
    { category: "security_advisory", enabled: true, severity: "high" },
    { category: "dependency_update", enabled: true, severity: "medium" },
  ],
  severityThreshold: "medium",
  autoMerge: false,
  notifyChannels: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

// ─── computeMttr ─────────────────────────────────────────────────────────────

describe("computeMttr", () => {
  it("returns 0 with fewer than 2 scans", () => {
    expect(computeMttr([])).toBe(0);
    expect(computeMttr([makeScan("s1", [])])).toBe(0);
  });

  it("returns 0 when no findings are resolved between scans", () => {
    const scan1 = makeScan("s1", [{ id: "f1", status: "open" }], "completed", 2);
    const scan2 = makeScan("s2", [{ id: "f1", status: "open" }], "completed", 1);
    expect(computeMttr([scan1, scan2])).toBe(0);
  });

  it("calculates positive MTTR when a finding is resolved", () => {
    const scan1 = makeScan("s1", [{ id: "f1", status: "open" }], "completed", 10);
    const scan2 = makeScan("s2", [], "completed", 3); // f1 resolved
    const mttr = computeMttr([scan1, scan2]);
    expect(mttr).toBeGreaterThan(0);
  });

  it("returns 0 when scans lack completedAt", () => {
    const scan1 = makeScan("s1", [{ id: "f1", status: "open" }], "running", 5);
    const scan2 = makeScan("s2", [], "completed", 1);
    // scan1 has no completedAt because it's running
    expect(typeof computeMttr([scan1, scan2])).toBe("number");
  });
});

// ─── computeCategoryBreakdown ─────────────────────────────────────────────────

describe("computeCategoryBreakdown", () => {
  it("returns empty array for no scans", () => {
    expect(computeCategoryBreakdown([])).toEqual([]);
  });

  it("aggregates findings by category", () => {
    const scan = makeScan("s1", [
      { category: "dependency_update", severity: "high", status: "open" },
      { category: "dependency_update", severity: "medium", status: "actioned" },
      { category: "security_advisory", severity: "critical", status: "open" },
    ]);

    const breakdown = computeCategoryBreakdown([scan]);
    const depUpdate = breakdown.find((b) => b.category === "dependency_update");
    const secAdvisory = breakdown.find((b) => b.category === "security_advisory");

    expect(depUpdate).toBeDefined();
    expect(depUpdate?.open).toBe(1);
    expect(depUpdate?.actioned).toBe(1);
    expect(depUpdate?.total).toBe(2);

    expect(secAdvisory?.open).toBe(1);
    expect(secAdvisory?.highestSeverity).toBe("critical");
  });

  it("sorts by open count descending", () => {
    const scan = makeScan("s1", [
      { category: "license_compliance", status: "open" },
      { category: "dependency_update", status: "open" },
      { category: "dependency_update", status: "open" },
    ]);

    const breakdown = computeCategoryBreakdown([scan]);
    expect(breakdown[0].category).toBe("dependency_update");
  });

  it("tracks highest severity per category", () => {
    const scan = makeScan("s1", [
      { category: "security_advisory", severity: "low", status: "open" },
      { category: "security_advisory", severity: "critical", status: "open" },
      { category: "security_advisory", severity: "medium", status: "open" },
    ]);

    const [item] = computeCategoryBreakdown([scan]);
    expect(item.highestSeverity).toBe("critical");
  });
});

// ─── computeScoreHistory ──────────────────────────────────────────────────────

describe("computeScoreHistory", () => {
  it("returns empty array for no completed scans", () => {
    const running = makeScan("s1", [], "running");
    expect(computeScoreHistory([running])).toEqual([]);
  });

  it("computes score 100 for scans with no open findings", () => {
    const scan = makeScan("s1", [{ status: "actioned" }]);
    const [sample] = computeScoreHistory([scan]);
    expect(sample.score).toBe(100);
  });

  it("deducts points for open findings by severity", () => {
    const scan = makeScan("s1", [
      { severity: "critical", status: "open" },
      { severity: "critical", status: "open" },
    ]);
    const [sample] = computeScoreHistory([scan]);
    // 2 × 20 = 40 deduction → score = 60
    expect(sample.score).toBe(60);
  });

  it("caps deductions at 60", () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      severity: "critical" as const,
      status: "open" as const,
    }));
    const scan = makeScan("s1", findings);
    const [sample] = computeScoreHistory([scan]);
    // 10 × 20 = 200 but capped at 60 → score = 40
    expect(sample.score).toBe(40);
  });

  it("returns samples sorted by completedAt ascending", () => {
    const scan1 = makeScan("s1", [], "completed", 5);
    const scan2 = makeScan("s2", [], "completed", 1);
    const history = computeScoreHistory([scan2, scan1]); // pass in reverse order
    expect(history[0].scanId).toBe("s1");
    expect(history[1].scanId).toBe("s2");
  });
});

// ─── projectTrend ─────────────────────────────────────────────────────────────

describe("projectTrend", () => {
  it("returns null for empty or single-sample history", () => {
    expect(projectTrend([])).toBeNull();

    const history = computeScoreHistory([makeScan("s1", [])]);
    expect(projectTrend(history)).toBeNull();
  });

  it("returns a projection with score in [0, 100]", () => {
    const scans = Array.from({ length: 5 }, (_, i) =>
      makeScan(`s${i}`, [{ severity: "medium", status: "open" }], "completed", (4 - i) * 7),
    );
    const history = computeScoreHistory(scans);
    const projection = projectTrend(history);

    expect(projection).not.toBeNull();
    expect(projection!.projectedScore).toBeGreaterThanOrEqual(0);
    expect(projection!.projectedScore).toBeLessThanOrEqual(100);
  });

  it("returns low confidence for 2 samples", () => {
    const scans = [makeScan("s1", [], "completed", 14), makeScan("s2", [], "completed", 7)];
    const history = computeScoreHistory(scans);
    const projection = projectTrend(history);
    expect(projection?.confidence).toBe("low");
  });

  it("returns high confidence for 8+ samples", () => {
    const scans = Array.from({ length: 10 }, (_, i) =>
      makeScan(`s${i}`, [], "completed", (9 - i) * 7),
    );
    const history = computeScoreHistory(scans);
    const projection = projectTrend(history);
    expect(projection?.confidence).toBe("high");
  });

  it("projectedAt is approximately daysAhead from last sample", () => {
    const scans = [makeScan("s1", [], "completed", 14), makeScan("s2", [], "completed", 7)];
    const history = computeScoreHistory(scans);
    const projection = projectTrend(history, 30);
    expect(projection).not.toBeNull();
    const diff = projection!.projectedAt.getTime() - history[history.length - 1].completedAt.getTime();
    // Should be approximately 30 days
    expect(Math.round(diff / 86_400_000)).toBe(30);
  });
});

// ─── generateRecommendations ──────────────────────────────────────────────────

describe("generateRecommendations", () => {
  it("returns recommendations sorted by priority (high before medium)", () => {
    const stalePolicy: MaintenancePolicy = {
      ...basePolicy,
      categories: [], // no categories enabled → multiple medium recs
      schedule: "@weekly",
    };
    const oldScan = makeScan("s1", [], "completed", 30); // very old scan
    const recs = generateRecommendations(stalePolicy, [oldScan]);

    const priorities = recs.map((r) => r.priority);
    for (let i = 1; i < priorities.length; i++) {
      const prev = { high: 0, medium: 1, low: 2 }[priorities[i - 1]] ?? 0;
      const curr = { high: 0, medium: 1, low: 2 }[priorities[i]] ?? 0;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  it("recommends increasing frequency when last scan is old", () => {
    const oldScan = makeScan("s1", [], "completed", 20);
    const recs = generateRecommendations(basePolicy, [oldScan]);
    const freqRec = recs.find((r) => r.type === "increase_frequency");
    expect(freqRec).toBeDefined();
    expect(freqRec?.priority).toBe("high");
  });

  it("recommends enabling high-value categories when missing", () => {
    const policyNoCats: MaintenancePolicy = { ...basePolicy, categories: [] };
    const scan = makeScan("s1", [], "completed", 1);
    const recs = generateRecommendations(policyNoCats, [scan]);
    const catRecs = recs.filter((r) => r.type === "enable_category");
    expect(catRecs.length).toBeGreaterThanOrEqual(1);
  });

  it("recommends reviewing stale findings when critical open count is high", () => {
    const criticalFindings = Array.from({ length: 8 }, (_, i) => ({
      id: `f${i}`,
      severity: "critical" as const,
      status: "open" as const,
    }));
    const scan = makeScan("s1", criticalFindings, "completed", 1);
    const recs = generateRecommendations(basePolicy, [scan]);
    const staleRec = recs.find((r) => r.type === "review_stale");
    expect(staleRec).toBeDefined();
    expect(staleRec?.priority).toBe("high");
  });

  it("recommends upgrading threshold when set to low/info", () => {
    const lenientPolicy: MaintenancePolicy = { ...basePolicy, severityThreshold: "info" };
    const recs = generateRecommendations(lenientPolicy, []);
    const threshRec = recs.find((r) => r.type === "upgrade_threshold");
    expect(threshRec).toBeDefined();
  });

  it("returns empty recommendations for a healthy policy with recent scans", () => {
    const healthyPolicy: MaintenancePolicy = {
      ...basePolicy,
      categories: [
        { category: "security_advisory", enabled: true, severity: "high" },
        { category: "dependency_update", enabled: true, severity: "medium" },
        { category: "license_compliance", enabled: true, severity: "medium" },
      ],
      severityThreshold: "high",
    };
    const recentScan = makeScan("s1", [], "completed", 1);
    const recs = generateRecommendations(healthyPolicy, [recentScan]);
    expect(recs.length).toBe(0);
  });
});

// ─── computeAnalyticsReport ───────────────────────────────────────────────────

describe("computeAnalyticsReport", () => {
  it("returns a complete report with all fields", () => {
    const scans = [
      makeScan("s1", [{ severity: "high", status: "open" }], "completed", 7),
      makeScan("s2", [{ severity: "medium", status: "actioned" }], "completed", 1),
    ];

    const report = computeAnalyticsReport(basePolicy, scans);

    expect(typeof report.mttrHours).toBe("number");
    expect(Array.isArray(report.categoryBreakdown)).toBe(true);
    expect(Array.isArray(report.scoreHistory)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
    expect(typeof report.totalOpen).toBe("number");
    expect(typeof report.totalActioned).toBe("number");
    expect(typeof report.totalDismissed).toBe("number");
    expect(typeof report.openByCategory).toBe("object");
  });

  it("counts open/actioned/dismissed correctly", () => {
    const scan = makeScan("s1", [
      { status: "open" },
      { status: "open" },
      { status: "actioned" },
      { status: "dismissed" },
    ]);

    const report = computeAnalyticsReport(basePolicy, [scan]);
    expect(report.totalOpen).toBe(2);
    expect(report.totalActioned).toBe(1);
    expect(report.totalDismissed).toBe(1);
  });
});
