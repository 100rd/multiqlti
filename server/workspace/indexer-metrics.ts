/**
 * IndexerMetrics — Issue #284
 *
 * In-process counters and histograms for the incremental indexer.
 * Metrics are exposed as a plain object via snapshot() so they can be
 * included in health-check responses or forwarded to Prometheus.
 *
 * Metric names follow the indexer.* namespace from the issue spec:
 *   indexer.events           — total filesystem events received
 *   indexer.reparse_duration — parse duration per file (histogram)
 *   indexer.patch_size       — patch ops per flush (histogram)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshot {
  events: number;
  reparseDuration: HistogramSnapshot;
  patchSize: HistogramSnapshot;
  fullRebuildCount: number;
  lastEventAt: string | null;
  lastFlushAt: string | null;
}

// ─── Histogram ────────────────────────────────────────────────────────────────

class Histogram {
  private samples: number[] = [];

  record(value: number): void {
    this.samples.push(value);
    // Keep at most 10 000 samples to bound memory
    if (this.samples.length > 10_000) {
      this.samples.shift();
    }
  }

  snapshot(): HistogramSnapshot {
    if (this.samples.length === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);

    return {
      count,
      sum,
      min: sorted[0],
      max: sorted[count - 1],
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    };
  }

  reset(): void {
    this.samples = [];
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ─── IndexerMetrics Class ─────────────────────────────────────────────────────

export class IndexerMetrics {
  private eventsCount = 0;
  private fullRebuildCount = 0;
  private lastEventAt: Date | null = null;
  private lastFlushAt: Date | null = null;

  private readonly reparseDuration = new Histogram();
  private readonly patchSizeHistogram = new Histogram();

  /** Record one filesystem event received by the watcher. */
  recordEvent(): void {
    this.eventsCount++;
    this.lastEventAt = new Date();
  }

  /** Record the parse duration (ms) for a single file. */
  recordReparseDuration(ms: number): void {
    this.reparseDuration.record(ms);
  }

  /** Record the number of patch ops in one flush. */
  recordPatchSize(opCount: number): void {
    this.patchSizeHistogram.record(opCount);
    this.lastFlushAt = new Date();
  }

  /** Increment the full-rebuild counter. */
  recordFullRebuild(): void {
    this.fullRebuildCount++;
  }

  /** Return a snapshot of all current metric values. */
  snapshot(): MetricsSnapshot {
    return {
      events: this.eventsCount,
      reparseDuration: this.reparseDuration.snapshot(),
      patchSize: this.patchSizeHistogram.snapshot(),
      fullRebuildCount: this.fullRebuildCount,
      lastEventAt: this.lastEventAt?.toISOString() ?? null,
      lastFlushAt: this.lastFlushAt?.toISOString() ?? null,
    };
  }

  /** Reset all counters and histograms. */
  reset(): void {
    this.eventsCount = 0;
    this.fullRebuildCount = 0;
    this.lastEventAt = null;
    this.lastFlushAt = null;
    this.reparseDuration.reset();
    this.patchSizeHistogram.reset();
  }
}
