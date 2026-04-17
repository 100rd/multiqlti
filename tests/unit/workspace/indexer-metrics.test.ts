/**
 * Unit tests for IndexerMetrics (Issue #284)
 *
 * Tests counter increments, histogram recording, snapshot shape,
 * and reset behaviour.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { IndexerMetrics } from "../../../server/workspace/indexer-metrics.js";

describe("IndexerMetrics", () => {
  let m: IndexerMetrics;

  beforeEach(() => {
    m = new IndexerMetrics();
  });

  it("1. initial snapshot has zero counts and null timestamps", () => {
    const snap = m.snapshot();
    expect(snap.events).toBe(0);
    expect(snap.fullRebuildCount).toBe(0);
    expect(snap.lastEventAt).toBeNull();
    expect(snap.lastFlushAt).toBeNull();
  });

  it("2. recordEvent increments the events counter", () => {
    m.recordEvent();
    m.recordEvent();
    expect(m.snapshot().events).toBe(2);
  });

  it("3. recordEvent updates lastEventAt", () => {
    const before = Date.now();
    m.recordEvent();
    const after = Date.now();
    const ts = new Date(m.snapshot().lastEventAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("4. recordFullRebuild increments fullRebuildCount", () => {
    m.recordFullRebuild();
    m.recordFullRebuild();
    expect(m.snapshot().fullRebuildCount).toBe(2);
  });

  it("5. recordReparseDuration records into histogram", () => {
    m.recordReparseDuration(10);
    m.recordReparseDuration(20);
    m.recordReparseDuration(30);
    const snap = m.snapshot();
    expect(snap.reparseDuration.count).toBe(3);
    expect(snap.reparseDuration.sum).toBe(60);
    expect(snap.reparseDuration.min).toBe(10);
    expect(snap.reparseDuration.max).toBe(30);
  });

  it("6. reparseDuration p50 is correct median", () => {
    for (let i = 1; i <= 100; i++) m.recordReparseDuration(i);
    const snap = m.snapshot();
    expect(snap.reparseDuration.p50).toBeGreaterThanOrEqual(49);
    expect(snap.reparseDuration.p50).toBeLessThanOrEqual(51);
  });

  it("7. reparseDuration p95 is correct", () => {
    for (let i = 1; i <= 100; i++) m.recordReparseDuration(i);
    const snap = m.snapshot();
    expect(snap.reparseDuration.p95).toBeGreaterThanOrEqual(94);
    expect(snap.reparseDuration.p95).toBeLessThanOrEqual(96);
  });

  it("8. recordPatchSize records into histogram", () => {
    m.recordPatchSize(5);
    m.recordPatchSize(10);
    const snap = m.snapshot();
    expect(snap.patchSize.count).toBe(2);
    expect(snap.patchSize.sum).toBe(15);
  });

  it("9. recordPatchSize updates lastFlushAt", () => {
    const before = Date.now();
    m.recordPatchSize(1);
    const after = Date.now();
    const ts = new Date(m.snapshot().lastFlushAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("10. reset() clears all counters and histograms", () => {
    m.recordEvent();
    m.recordFullRebuild();
    m.recordReparseDuration(100);
    m.recordPatchSize(50);

    m.reset();

    const snap = m.snapshot();
    expect(snap.events).toBe(0);
    expect(snap.fullRebuildCount).toBe(0);
    expect(snap.reparseDuration.count).toBe(0);
    expect(snap.patchSize.count).toBe(0);
    expect(snap.lastEventAt).toBeNull();
    expect(snap.lastFlushAt).toBeNull();
  });

  it("11. histogram with 0 samples returns all-zero snapshot", () => {
    const snap = m.snapshot();
    expect(snap.reparseDuration.min).toBe(0);
    expect(snap.reparseDuration.max).toBe(0);
    expect(snap.reparseDuration.p50).toBe(0);
  });

  it("12. histogram with single sample has min == max == p50 == p95 == p99", () => {
    m.recordReparseDuration(42);
    const snap = m.snapshot();
    expect(snap.reparseDuration.min).toBe(42);
    expect(snap.reparseDuration.max).toBe(42);
    expect(snap.reparseDuration.p50).toBe(42);
    expect(snap.reparseDuration.p95).toBe(42);
    expect(snap.reparseDuration.p99).toBe(42);
  });

  it("13. metrics indexer.events label is tracked via recordEvent", () => {
    // This test validates the metric name / counter mapping in the spec
    for (let i = 0; i < 5; i++) m.recordEvent();
    expect(m.snapshot().events).toBe(5);
  });

  it("14. metrics indexer.reparse_duration histogram is separate from patch_size", () => {
    m.recordReparseDuration(100);
    m.recordPatchSize(200);
    expect(m.snapshot().reparseDuration.count).toBe(1);
    expect(m.snapshot().patchSize.count).toBe(1);
    expect(m.snapshot().reparseDuration.sum).toBe(100);
    expect(m.snapshot().patchSize.sum).toBe(200);
  });
});
