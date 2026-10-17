import { describe, expect, it } from "vitest";

import { percentile, summarizeFrameTimes } from "./perf";

describe("percentile", () => {
  it("interpolates between sorted samples", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBeCloseTo(4.8);
    expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1);
    expect(percentile([5, 1, 3, 2, 4], 100)).toBe(5);
  });
});

describe("summarizeFrameTimes", () => {
  it("reports count, average, percentiles and long frames", () => {
    const summary = summarizeFrameTimes([16, 16, 16, 33.4, 0, Number.NaN, -1]);

    expect(summary.count).toBe(4);
    expect(summary.avgMs).toBeCloseTo(20.35);
    expect(summary.minMs).toBe(16);
    expect(summary.maxMs).toBe(33.4);
    expect(summary.p50Ms).toBeCloseTo(16);
    expect(summary.p95Ms).toBeGreaterThan(16);
    expect(summary.fps).toBeCloseTo(1000 / 20.35);
    expect(summary.longFrames).toBe(1);
  });

  it("returns a zeroed summary for no usable samples", () => {
    expect(summarizeFrameTimes([])).toEqual({
      count: 0,
      minMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      fps: 0,
      longFrames: 0,
    });
  });
});
