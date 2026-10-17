/**
 * 渲染性能采样的纯计算工具（零引擎依赖，可在 vitest 中直测）。
 */

/** 30fps 对应的帧预算，超过即视为长帧。 */
export const LONG_FRAME_MS = 1000 / 30;

export interface FrameTimeSummary {
  count: number;
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** 由平均帧时间折算的帧率。 */
  fps: number;
  /** 超过 longFrameMs 的帧数。 */
  longFrames: number;
}

/** 线性插值分位数（p 取 0–100）。空数组返回 0。 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function summarizeFrameTimes(
  values: readonly number[],
  longFrameMs = LONG_FRAME_MS,
): FrameTimeSummary {
  const samples = values.filter((value) => Number.isFinite(value) && value > 0);
  if (samples.length === 0) {
    return {
      count: 0,
      minMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      fps: 0,
      longFrames: 0,
    };
  }

  const total = samples.reduce((sum, value) => sum + value, 0);
  const avgMs = total / samples.length;

  return {
    count: samples.length,
    minMs: Math.min(...samples),
    avgMs,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: Math.max(...samples),
    fps: avgMs > 0 ? 1000 / avgMs : 0,
    longFrames: samples.filter((value) => value > longFrameMs).length,
  };
}
