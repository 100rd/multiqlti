/**
 * Maintenance Analytics Engine — Phase 4.5 PR 4
 *
 * Computes derived metrics from maintenance scan history:
 *   - MTTR (Mean Time to Remediate)
 *   - Health score trend projection
 *   - Category breakdown and heatmaps
 *   - Actionable recommendations
 *
 * All functions are pure (no DB calls) — the caller fetches data and passes it in.
 * This makes testing straightforward without mocking.
 */

import type {
  ScoutFinding,
  MaintenanceScan,
  MaintenancePolicy,
  HealthScore,
  Recommendation,
  MaintenanceCategory,
  MaintenanceSeverity,
} from "@shared/types";

// ─── MTTR ─────────────────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<MaintenanceSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/**
 * Compute mean time to remediate in hours.
 *
 * A finding is "remediated" when its status changes from "open" to "actioned"
 * or "dismissed". Since individual findings don't track timestamps, we
 * approximate MTTR as the average time between the scan that introduced a
 * finding and the scan where it disappeared.
 *
 * Simplified model: compare open findings across consecutive scans. A finding
 * is resolved when its id no longer appears in open findings in a later scan.
 */
export function computeMttr(scans: MaintenanceScan[]): number {
  if (scans.length < 2) return 0;

  // Sort ascending by startedAt
  const sorted = [...scans].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  let totalHours = 0;
  let resolvedCount = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const scanA = sorted[i];
    const scanB = sorted[i + 1];

    if (!scanA.completedAt || !scanB.startedAt) continue;

    const openInA = new Set(
      ((scanA.findings as ScoutFinding[]) ?? [])
        .filter((f) => f.status === "open")
        .map((f) => f.id),
    );

    const openInB = new Set(
      ((scanB.findings as ScoutFinding[]) ?? [])
        .filter((f) => f.status === "open")
        .map((f) => f.id),
    );

    // Findings that were open in A but not open in B are resolved
    for (const id of openInA) {
      if (!openInB.has(id)) {
        const scanAEnd = new Date(scanA.completedAt).getTime();
        const scanBStart = new Date(scanB.startedAt).getTime();
        const deltaHours = (scanBStart - scanAEnd) / 3_600_000;
        if (deltaHours >= 0) {
          totalHours += deltaHours;
          resolvedCount++;
        }
      }
    }
  }

  if (resolvedCount === 0) return 0;
  return Math.round((totalHours / resolvedCount) * 10) / 10;
}

// ─── Category Breakdown ───────────────────────────────────────────────────────

export interface CategoryBreakdown {
  category: MaintenanceCategory;
  open: number;
  actioned: number;
  dismissed: number;
  total: number;
  highestSeverity: MaintenanceSeverity | null;
}

/**
 * Aggregate finding counts by category across all provided scans.
 */
export function computeCategoryBreakdown(scans: MaintenanceScan[]): CategoryBreakdown[] {
  const map = new Map<MaintenanceCategory, CategoryBreakdown>();

  for (const scan of scans) {
    const findings = (scan.findings as ScoutFinding[]) ?? [];
    for (const f of findings) {
      const existing = map.get(f.category) ?? {
        category: f.category,
        open: 0,
        actioned: 0,
        dismissed: 0,
        total: 0,
        highestSeverity: null,
      };

      if (f.status === "open") existing.open++;
      else if (f.status === "actioned") existing.actioned++;
      else if (f.status === "dismissed") existing.dismissed++;
      existing.total++;

      // Track highest severity seen
      if (
        !existing.highestSeverity ||
        SEVERITY_WEIGHT[f.severity] > SEVERITY_WEIGHT[existing.highestSeverity]
      ) {
        existing.highestSeverity = f.severity;
      }

      map.set(f.category, existing);
    }
  }

  return Array.from(map.values()).sort((a, b) => b.open - a.open);
}

// ─── Score History ────────────────────────────────────────────────────────────

export interface ScoreSample {
  scanId: string;
  completedAt: Date;
  score: number;
  openCount: number;
}

/**
 * Build a time-series of health scores from completed scans.
 * Uses the same deduction formula as the health route.
 */
export function computeScoreHistory(scans: MaintenanceScan[]): ScoreSample[] {
  return scans
    .filter((s) => s.status === "completed" && s.completedAt)
    .sort((a, b) => new Date(a.completedAt!).getTime() - new Date(b.completedAt!).getTime())
    .map((s) => {
      const findings = (s.findings as ScoutFinding[]) ?? [];
      const open = findings.filter((f) => f.status === "open");
      const deductions = Math.min(
        60,
        open.filter((f) => f.severity === "critical").length * 20 +
          open.filter((f) => f.severity === "high").length * 10 +
          open.filter((f) => f.severity === "medium").length * 3 +
          open.filter((f) => f.severity === "low").length * 1,
      );
      return {
        scanId: s.id,
        completedAt: new Date(s.completedAt!),
        score: Math.max(0, Math.min(100, 100 - deductions)),
        openCount: open.length,
      };
    });
}

// ─── Trend Projection ─────────────────────────────────────────────────────────

export interface TrendProjection {
  projectedScore: number;
  projectedAt: Date;
  confidence: "high" | "medium" | "low";
}

/**
 * Project the health score 30 days forward using linear regression
 * on the last N score samples.
 */
export function projectTrend(
  history: ScoreSample[],
  daysAhead = 30,
  sampleCount = 10,
): TrendProjection | null {
  if (history.length < 2) return null;

  const samples = history.slice(-sampleCount);
  const n = samples.length;

  // Convert timestamps to days-since-first-sample
  const t0 = samples[0].completedAt.getTime();
  const xs = samples.map((s) => (s.completedAt.getTime() - t0) / 86_400_000);
  const ys = samples.map((s) => s.score);

  // Simple least-squares linear regression
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  const lastX = xs[xs.length - 1];
  const projectedX = lastX + daysAhead;
  const projectedScore = Math.max(0, Math.min(100, slope * projectedX + intercept));

  const confidence: TrendProjection["confidence"] =
    n >= 8 ? "high" : n >= 4 ? "medium" : "low";

  const projectedAt = new Date(samples[samples.length - 1].completedAt.getTime() + daysAhead * 86_400_000);

  return {
    projectedScore: Math.round(projectedScore * 10) / 10,
    projectedAt,
    confidence,
  };
}

// ─── Recommendations ──────────────────────────────────────────────────────────

/**
 * Generate actionable recommendations from scan history and policy settings.
 * Returns an array sorted by priority (high → low).
 */
export function generateRecommendations(
  policy: MaintenancePolicy,
  recentScans: MaintenanceScan[],
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  const completedScans = recentScans.filter((s) => s.status === "completed");
  const allFindings = completedScans.flatMap((s) => (s.findings as ScoutFinding[]) ?? []);
  const openFindings = allFindings.filter((f) => f.status === "open");

  // Recommendation: increase scan frequency if scans are infrequent
  if (completedScans.length > 0 && completedScans[0].completedAt) {
    const latestScan = completedScans
      .filter((s) => s.completedAt)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())[0];

    if (latestScan?.completedAt) {
      const ageMs = Date.now() - new Date(latestScan.completedAt).getTime();
      const ageDays = ageMs / 86_400_000;

      if (ageDays > 14) {
        recommendations.push({
          type: "increase_frequency",
          message: `Last scan was ${Math.round(ageDays)} days ago. Consider changing the schedule from "${policy.schedule}" to a more frequent interval to stay ahead of issues.`,
          priority: "high",
          actionable: true,
          suggestedChange: { schedule: "0 9 * * 1" }, // weekly
        });
      }
    }
  }

  // Recommendation: enable unconfigured high-value categories
  const enabledCategoryNames = new Set(policy.categories.filter((c) => c.enabled).map((c) => c.category));
  const highValueCategories: MaintenanceCategory[] = ["security_advisory", "dependency_update", "license_compliance"];

  for (const cat of highValueCategories) {
    if (!enabledCategoryNames.has(cat)) {
      recommendations.push({
        type: "enable_category",
        message: `The "${cat}" scanner is not enabled. Enabling it will improve security posture and dependency hygiene.`,
        priority: "medium",
        actionable: true,
        suggestedChange: {
          categories: [
            ...policy.categories,
            { category: cat, enabled: true, severity: "high" },
          ],
        },
      });
    }
  }

  // Recommendation: stale open findings
  const criticalOpen = openFindings.filter((f) => f.severity === "critical" || f.severity === "high");
  if (criticalOpen.length > 5) {
    recommendations.push({
      type: "review_stale",
      message: `There are ${criticalOpen.length} critical/high severity open findings that have not been actioned. Review and triage to improve the health score.`,
      priority: "high",
      actionable: true,
    });
  }

  // Recommendation: upgrade severity threshold if too permissive
  if (policy.severityThreshold === "low" || policy.severityThreshold === "info") {
    recommendations.push({
      type: "upgrade_threshold",
      message: `The severity threshold is set to "${policy.severityThreshold}". Tightening it to "medium" or "high" will surface more meaningful issues and reduce noise.`,
      priority: "low",
      actionable: true,
      suggestedChange: { severityThreshold: "medium" },
    });
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

// ─── Full Analytics Report ────────────────────────────────────────────────────

export interface AnalyticsReport {
  mttrHours: number;
  categoryBreakdown: CategoryBreakdown[];
  scoreHistory: ScoreSample[];
  projection: TrendProjection | null;
  recommendations: Recommendation[];
  openByCategory: Partial<Record<MaintenanceCategory, number>>;
  totalOpen: number;
  totalActioned: number;
  totalDismissed: number;
}

/**
 * Compute a full analytics report for a workspace's scan history.
 */
export function computeAnalyticsReport(
  policy: MaintenancePolicy,
  scans: MaintenanceScan[],
): AnalyticsReport {
  const categoryBreakdown = computeCategoryBreakdown(scans);
  const scoreHistory = computeScoreHistory(scans);
  const projection = projectTrend(scoreHistory);
  const mttrHours = computeMttr(scans);
  const recommendations = generateRecommendations(policy, scans);

  const allFindings = scans.flatMap((s) => (s.findings as ScoutFinding[]) ?? []);
  const openByCategory: Partial<Record<MaintenanceCategory, number>> = {};
  for (const breakdown of categoryBreakdown) {
    if (breakdown.open > 0) {
      openByCategory[breakdown.category] = breakdown.open;
    }
  }

  return {
    mttrHours,
    categoryBreakdown,
    scoreHistory,
    projection,
    recommendations,
    openByCategory,
    totalOpen: allFindings.filter((f) => f.status === "open").length,
    totalActioned: allFindings.filter((f) => f.status === "actioned").length,
    totalDismissed: allFindings.filter((f) => f.status === "dismissed").length,
  };
}
