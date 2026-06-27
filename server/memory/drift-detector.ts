import { Observation } from './provenance-graph.js';

// Re-export the DriftAlert interface or declare it in drift-detector.ts
// Wait, the plan.md lists DriftAlert and DriftDetector class. Let's declare them here and export them.
export interface DriftAlert {
  metricName: string;
  baselineValue: number;
  currentValue: number;
  driftPercentage: number;
  timestamp: string;
}

export class DriftDetector {
  constructor(private thresholdPercentage: number) {}

  detect(currentStream: Observation[], baseline: Observation): DriftAlert[] {
    if (!baseline || !currentStream) {
      return [];
    }

    const alerts: DriftAlert[] = [];

    for (const current of currentStream) {
      if (current.metricName !== baseline.metricName) {
        continue;
      }

      const baselineVal = baseline.value;
      const currentVal = current.value;

      let driftPercentage = 0;
      if (baselineVal === 0) {
        if (currentVal !== 0) {
          driftPercentage = Infinity;
        } else {
          driftPercentage = 0;
        }
      } else {
        driftPercentage = Math.abs(currentVal - baselineVal) / Math.abs(baselineVal);
      }

      if (driftPercentage > this.thresholdPercentage) {
        alerts.push({
          metricName: baseline.metricName,
          baselineValue: baselineVal,
          currentValue: currentVal,
          driftPercentage,
          timestamp: current.timestamp,
        });
      }
    }

    return alerts;
  }
}
