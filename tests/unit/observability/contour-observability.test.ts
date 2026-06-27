import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObservabilityStore } from "../../../server/pipeline/observability/observability-store";
import { AlertChannel } from "../../../server/pipeline/observability/alert-channel";
import { ContourObservabilityService } from "../../../server/pipeline/observability/contour-observability";

describe("ContourObservabilityService (PART XII)", () => {
  let store: ObservabilityStore;
  let alertChannel: AlertChannel;
  let service: ContourObservabilityService;

  beforeEach(() => {
    store = new ObservabilityStore();
    alertChannel = new AlertChannel();
    // Use a 7-day delay window and 2% threshold
    service = new ContourObservabilityService(store, alertChannel, {
      yieldDelayWindowMs: 7 * 24 * 60 * 60 * 1000, 
      escapeRateThreshold: 2.0,
    });
  });

  it("should calculate yield correctly for tasks beyond the delay window", () => {
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;

    // 10 days ago (past window, analyzable)
    service.recordTaskVerdict("task-1", "success", "skill-a", tenDaysAgo);
    service.recordTaskVerdict("task-2", "success", "skill-b", tenDaysAgo);
    service.recordTaskVerdict("task-3", "failure", "skill-a", tenDaysAgo);

    // 1 day ago (inside window, NOT analyzable yet)
    service.recordTaskVerdict("task-4", "success", "skill-c", oneDayAgo);

    const metrics = service.getYieldMetrics(now);

    expect(metrics.totalAnalyzedRuns).toBe(3); // task-4 is ignored
    expect(metrics.successfulRuns).toBe(2);
    expect(metrics.failedRuns).toBe(1);
    expect(metrics.escapedSafetyRuns).toBe(0);
    expect(metrics.yieldPercentage).toBeCloseTo((2 / 3) * 100);
    expect(metrics.escapeRatePercentage).toBe(0);
  });

  it("should correctly handle escaped incidents and fire TrustDegradationAlert", () => {
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    // Spy on the alert channel
    const fireAlertSpy = vi.spyOn(alertChannel, "fireTrustDegradationAlert");

    // We have 100 tasks, all initially successful
    for (let i = 0; i < 100; i++) {
      service.recordTaskVerdict(`task-${i}`, "success", "skill-a", tenDaysAgo);
    }

    // Yield should be 100%, Escape Rate 0%
    let metrics = service.getYieldMetrics(now);
    expect(metrics.yieldPercentage).toBe(100);
    expect(metrics.escapeRatePercentage).toBe(0);

    // Now, 3 tasks come back as bugs (escaped safety)
    service.reportEscapedIncident("task-5", now);
    service.reportEscapedIncident("task-15", now);
    service.reportEscapedIncident("task-25", now); // This one pushes escape rate to 3%

    metrics = service.getYieldMetrics(now);

    expect(metrics.successfulRuns).toBe(97);
    expect(metrics.failedRuns).toBe(3); // Escaped tasks count as failures
    expect(metrics.escapedSafetyRuns).toBe(3);
    expect(metrics.yieldPercentage).toBe(97);
    expect(metrics.escapeRatePercentage).toBe(3);

    // Threshold is 2.0%, so the third report should have fired the alert
    expect(fireAlertSpy).toHaveBeenCalled();
    const alertCall = fireAlertSpy.mock.calls[fireAlertSpy.mock.calls.length - 1][0];
    expect(alertCall.escapeRate).toBe(3);
    expect(alertCall.analyzedRuns).toBe(100);
  });

  it("should calculate specific skill success rate (Trust Drift)", () => {
    const now = Date.now();
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    service.recordTaskVerdict("t1", "success", "skill-auth", tenDaysAgo);
    service.recordTaskVerdict("t2", "success", "skill-auth", tenDaysAgo);
    service.recordTaskVerdict("t3", "failure", "skill-auth", tenDaysAgo);
    service.recordTaskVerdict("t4", "success", "skill-db", tenDaysAgo);

    expect(service.getSkillSuccessRate("skill-auth")).toBeCloseTo((2 / 3) * 100);
    expect(service.getSkillSuccessRate("skill-db")).toBe(100);

    // An incident on t2 drops auth success to 1/3 (33%)
    service.reportEscapedIncident("t2", now);
    expect(service.getSkillSuccessRate("skill-auth")).toBeCloseTo((1 / 3) * 100);
  });
});
