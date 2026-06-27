import { ObservabilityStore, TaskExecutionRecord } from "./observability-store";
import { AlertChannel } from "./alert-channel";

export interface YieldMetrics {
  totalAnalyzedRuns: number;
  successfulRuns: number;
  failedRuns: number;
  escapedSafetyRuns: number;
  yieldPercentage: number;
  escapeRatePercentage: number;
}

export interface ContourObservabilityConfig {
  /**
   * The delay window in milliseconds before a task is considered "safely verified"
   * Default: 7 days (7 * 24 * 60 * 60 * 1000)
   */
  yieldDelayWindowMs: number;
  
  /**
   * The escape rate percentage threshold that triggers a TrustDegradationAlert
   * Default: 2.0 (2%)
   */
  escapeRateThreshold: number;
}

export class ContourObservabilityService {
  private store: ObservabilityStore;
  private alertChannel: AlertChannel;
  private config: ContourObservabilityConfig;

  constructor(
    store: ObservabilityStore,
    alertChannel: AlertChannel,
    config?: Partial<ContourObservabilityConfig>
  ) {
    this.store = store;
    this.alertChannel = alertChannel;
    this.config = {
      yieldDelayWindowMs: 7 * 24 * 60 * 60 * 1000,
      escapeRateThreshold: 2.0,
      ...config,
    };
  }

  recordTaskVerdict(
    taskId: string,
    initialVerdict: "success" | "failure",
    skillId?: string,
    timestamp: number = Date.now()
  ): void {
    this.store.recordTaskExecution(taskId, initialVerdict, skillId, timestamp);
    // Escape rate isn't usually recalculated on successful run instantly, 
    // but a failure might trigger a quick check.
  }

  reportEscapedIncident(taskId: string, timestamp: number = Date.now()): void {
    this.store.reportIncident(taskId, timestamp);
    
    // Evaluate if this new incident breached the escape rate threshold
    this.evaluateTrustDrift();
  }

  /**
   * Computes yield and escape rate for tasks that are older than the delay window.
   */
  getYieldMetrics(currentTime: number = Date.now()): YieldMetrics {
    const allRecords = this.store.getAllRecords();
    
    // Only analyze tasks that have passed the delay window
    const analyzableRecords = allRecords.filter(
      (r) => (currentTime - r.executionTimestamp) >= this.config.yieldDelayWindowMs
    );

    let successfulRuns = 0;
    let failedRuns = 0;
    let escapedSafetyRuns = 0;

    for (const record of analyzableRecords) {
      if (record.isEscaped) {
        escapedSafetyRuns++;
        failedRuns++; // An escaped task is ultimately a failure
      } else if (record.initialVerdict === "success") {
        successfulRuns++;
      } else {
        failedRuns++;
      }
    }

    const totalAnalyzedRuns = analyzableRecords.length;
    const yieldPercentage =
      totalAnalyzedRuns > 0 ? (successfulRuns / totalAnalyzedRuns) * 100 : 100;
    const escapeRatePercentage =
      totalAnalyzedRuns > 0 ? (escapedSafetyRuns / totalAnalyzedRuns) * 100 : 0;

    return {
      totalAnalyzedRuns,
      successfulRuns,
      failedRuns,
      escapedSafetyRuns,
      yieldPercentage,
      escapeRatePercentage,
    };
  }

  /**
   * Calculates the success delta for a specific skill (Trust Drift)
   */
  getSkillSuccessRate(skillId: string): number {
    const records = this.store.getSkillRecords(skillId);
    if (records.length === 0) return 100;

    const successes = records.filter(r => r.initialVerdict === "success" && !r.isEscaped).length;
    return (successes / records.length) * 100;
  }

  /**
   * Evaluates the escape rate and fires the second human-wake channel if necessary
   */
  private evaluateTrustDrift(): void {
    const metrics = this.getYieldMetrics();
    if (metrics.escapeRatePercentage > this.config.escapeRateThreshold) {
      this.alertChannel.fireTrustDegradationAlert({
        escapeRate: metrics.escapeRatePercentage,
        threshold: this.config.escapeRateThreshold,
        analyzedRuns: metrics.totalAnalyzedRuns,
        message: `Escape rate of ${metrics.escapeRatePercentage.toFixed(2)}% breached the ${this.config.escapeRateThreshold}% threshold.`,
      });
    }
  }
}

export const contourObservability = new ContourObservabilityService(
  new ObservabilityStore(),
  new AlertChannel()
);
