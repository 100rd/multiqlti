import { describe, it, expect } from 'vitest';
import { DriftDetector } from '../../../server/memory/drift-detector.js';
import { Observation } from '../../../server/memory/provenance-graph.js';

describe('DriftDetector', () => {
  it('should not alert if relative change is within threshold', () => {
    const detector = new DriftDetector(0.5); // 50% threshold
    const baseline: Observation = {
      id: 'obs-base',
      timestamp: '2026-06-26T12:00:00Z',
      metricName: 'cpu_usage',
      value: 50,
    };
    const currentStream: Observation[] = [
      {
        id: 'obs-1',
        timestamp: '2026-06-26T12:01:00Z',
        metricName: 'cpu_usage',
        value: 60, // 20% increase (within 50% threshold)
      },
      {
        id: 'obs-2',
        timestamp: '2026-06-26T12:02:00Z',
        metricName: 'cpu_usage',
        value: 30, // 40% decrease (within 50% threshold)
      },
    ];

    const alerts = detector.detect(currentStream, baseline);
    expect(alerts).toEqual([]);
  });

  it('should alert if relative change exceeds threshold', () => {
    const detector = new DriftDetector(0.5); // 50% threshold
    const baseline: Observation = {
      id: 'obs-base',
      timestamp: '2026-06-26T12:00:00Z',
      metricName: 'cpu_usage',
      value: 50,
    };
    const currentStream: Observation[] = [
      {
        id: 'obs-1',
        timestamp: '2026-06-26T12:01:00Z',
        metricName: 'cpu_usage',
        value: 80, // 60% increase (exceeds 50% threshold)
      },
      {
        id: 'obs-2',
        timestamp: '2026-06-26T12:02:00Z',
        metricName: 'cpu_usage',
        value: 20, // 60% decrease (exceeds 50% threshold)
      },
    ];

    const alerts = detector.detect(currentStream, baseline);
    expect(alerts).toHaveLength(2);

    expect(alerts[0]).toEqual({
      metricName: 'cpu_usage',
      baselineValue: 50,
      currentValue: 80,
      driftPercentage: 0.6,
      timestamp: '2026-06-26T12:01:00Z',
    });

    expect(alerts[1]).toEqual({
      metricName: 'cpu_usage',
      baselineValue: 50,
      currentValue: 20,
      driftPercentage: 0.6,
      timestamp: '2026-06-26T12:02:00Z',
    });
  });

  it('should ignore observations with non-matching metric names', () => {
    const detector = new DriftDetector(0.1); // 10% threshold
    const baseline: Observation = {
      id: 'obs-base',
      timestamp: '2026-06-26T12:00:00Z',
      metricName: 'cpu_usage',
      value: 50,
    };
    const currentStream: Observation[] = [
      {
        id: 'obs-1',
        timestamp: '2026-06-26T12:01:00Z',
        metricName: 'memory_usage', // non-matching metric name
        value: 100, // 100% change, but wrong metric
      },
    ];

    const alerts = detector.detect(currentStream, baseline);
    expect(alerts).toEqual([]);
  });

  it('should handle baseline value of 0 correctly', () => {
    const detector = new DriftDetector(0.5); // 50% threshold
    const baseline: Observation = {
      id: 'obs-base',
      timestamp: '2026-06-26T12:00:00Z',
      metricName: 'error_count',
      value: 0,
    };
    const currentStream: Observation[] = [
      {
        id: 'obs-1',
        timestamp: '2026-06-26T12:01:00Z',
        metricName: 'error_count',
        value: 0, // no change, should not alert
      },
      {
        id: 'obs-2',
        timestamp: '2026-06-26T12:02:00Z',
        metricName: 'error_count',
        value: 5, // increase from 0, should alert (driftPercentage is Infinity)
      },
    ];

    const alerts = detector.detect(currentStream, baseline);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      metricName: 'error_count',
      baselineValue: 0,
      currentValue: 5,
      driftPercentage: Infinity,
      timestamp: '2026-06-26T12:02:00Z',
    });
  });
});
