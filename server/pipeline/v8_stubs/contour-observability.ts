export interface YieldMetrics {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  escapedSafetyRuns: number;
  yieldPercentage: number;
  escapeRatePercentage: number;
}

export class ContourObservabilityService {
  private totalRuns = 0;
  private successfulRuns = 0;
  private failedRuns = 0;
  private escapedSafetyRuns = 0;

  recordRun(status: "success" | "failure" | "escaped"): void {
    this.totalRuns++;
    if (status === "success") {
      this.successfulRuns++;
    } else if (status === "failure") {
      this.failedRuns++;
    } else if (status === "escaped") {
      this.escapedSafetyRuns++;
      this.failedRuns++;
    }
  }

  getYieldMetrics(): YieldMetrics {
    const yieldPercentage =
      this.totalRuns > 0 ? (this.successfulRuns / this.totalRuns) * 100 : 100;

    const escapeRatePercentage =
      this.totalRuns > 0 ? (this.escapedSafetyRuns / this.totalRuns) * 100 : 0;

    return {
      totalRuns: this.totalRuns,
      successfulRuns: this.successfulRuns,
      failedRuns: this.failedRuns,
      escapedSafetyRuns: this.escapedSafetyRuns,
      yieldPercentage,
      escapeRatePercentage,
    };
  }
}
