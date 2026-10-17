/**
 * 画质档位与动态分辨率（票 25）。
 *
 * 纯计算模块：不依赖 Babylon，可在 vitest 中直测。
 * renderScale 的语义是「相对 CSS 像素的渲染倍率」：
 *   renderScale = 1    → 原生 CSS 分辨率（DPR>1 时等于设备像素）
 *   renderScale = 0.75 → 渲染像素数降到 0.5625 倍
 * 场景层负责把它换算成 Babylon 的 hardwareScalingLevel。
 */

export type QualityLevel = "high" | "medium" | "low" | "auto";

export interface QualityPreset {
  /** 相对 CSS 像素的渲染倍率上限。 */
  renderScale: number;
  /** 是否开启遮挡/角色描边。 */
  outline: boolean;
  /** 是否开启色彩分级（DefaultRenderingPipeline）。 */
  grading: boolean;
}

export const QUALITY_PRESETS: Record<Exclude<QualityLevel, "auto">, QualityPreset> = {
  high: { renderScale: 1, outline: true, grading: true },
  medium: { renderScale: 0.8, outline: true, grading: true },
  low: { renderScale: 0.6, outline: false, grading: false },
};

/** 1080p 目标；动态分辨率不会超过这个像素量（高 DPR 屏会主动降采样）。 */
export const TARGET_RENDER_PIXELS = 1920 * 1080;

/**
 * 渲染倍率下限。0.25 允许 4K/高 DPR 大屏把像素量压回预算内；
 * 0.5 会在 2560×1440@2x 上产生 ~4.1MP（超出 1080p 预算 2 倍）。
 */
export const MIN_RENDER_SCALE = 0.25;
export const MAX_RENDER_SCALE = 1;

/** URL ?quality=... 解析；未知值回落到 auto（默认开启动态分辨率）。 */
export function parseQualityLevel(value: string | null | undefined): QualityLevel {
  if (value === "high" || value === "medium" || value === "low" || value === "auto") {
    return value;
  }
  return "auto";
}

/**
 * 在给定视口下，渲染像素数不超过 targetPixels 的最大 renderScale。
 * 结果同时受 MAX_RENDER_SCALE 限制（不做超采样）。
 */
export function maxScaleForPixels(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  targetPixels = TARGET_RENDER_PIXELS,
): number {
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const dpr = Math.max(1, devicePixelRatio);
  const scale = Math.sqrt(targetPixels / (width * height * dpr * dpr));
  return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, scale));
}

/** renderScale → Babylon hardwareScalingLevel（1 表示按设备像素渲染）。 */
export function renderScaleToHardwareScaling(
  renderScale: number,
  devicePixelRatio: number,
): number {
  const dpr = Math.max(1, devicePixelRatio);
  return 1 / (Math.max(0.01, renderScale) * dpr);
}

export interface DynamicResolutionOptions {
  minScale: number;
  maxScale: number;
  /** 平均帧时间超过该值就降档。 */
  decreaseFrameMs: number;
  /** 平均帧时间低于该值就升档。 */
  increaseFrameMs: number;
  stepDown: number;
  stepUp: number;
  /** 统计窗口帧数。 */
  windowSize: number;
  /** 启动后的预热帧数，不参与决策（避开首帧 shader 编译）。 */
  warmupFrames: number;
  /** 每次调整后至少跳过几个窗口再调整。 */
  cooldownWindows: number;
}

export const DEFAULT_DYNAMIC_RESOLUTION: DynamicResolutionOptions = {
  minScale: 0.5,
  maxScale: 1,
  decreaseFrameMs: 17.5,
  increaseFrameMs: 14.5,
  stepDown: 0.1,
  stepUp: 0.05,
  windowSize: 30,
  warmupFrames: 30,
  cooldownWindows: 1,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 动态分辨率控制器：
 * 每帧送入 frameMs，窗口结束时返回新的 renderScale；无需调整时返回 null。
 * 降档比升档更敏感（阈值更宽、步长更大），避免在 60fps 边缘来回抖动。
 */
export class DynamicResolutionController {
  readonly options: DynamicResolutionOptions;
  private currentScale: number;
  private readonly samples: number[] = [];
  private frameCount = 0;
  private windowsSinceChange = Number.POSITIVE_INFINITY;
  private adjustments = 0;

  constructor(
    initialScale: number,
    options: Partial<DynamicResolutionOptions> = {},
  ) {
    this.options = { ...DEFAULT_DYNAMIC_RESOLUTION, ...options };
    this.currentScale = clamp(
      initialScale,
      this.options.minScale,
      this.options.maxScale,
    );
  }

  get scale(): number {
    return this.currentScale;
  }

  get adjustmentCount(): number {
    return this.adjustments;
  }

  reset(scale: number): void {
    this.currentScale = clamp(scale, this.options.minScale, this.options.maxScale);
    this.samples.length = 0;
    this.frameCount = 0;
    this.windowsSinceChange = Number.POSITIVE_INFINITY;
  }

  /** 返回新 scale；未调整返回 null。 */
  sample(frameMs: number): number | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0) {
      return null;
    }
    this.frameCount += 1;
    if (this.frameCount <= this.options.warmupFrames) {
      return null;
    }

    this.samples.push(frameMs);
    if (this.samples.length < this.options.windowSize) {
      return null;
    }

    const average =
      this.samples.reduce((sum, value) => sum + value, 0) / this.samples.length;
    this.samples.length = 0;

    if (this.windowsSinceChange < this.options.cooldownWindows) {
      this.windowsSinceChange += 1;
      return null;
    }

    let next: number | null = null;
    if (average > this.options.decreaseFrameMs) {
      next = Math.max(
        this.options.minScale,
        Number((this.currentScale - this.options.stepDown).toFixed(2)),
      );
    } else if (average < this.options.increaseFrameMs) {
      next = Math.min(
        this.options.maxScale,
        Number((this.currentScale + this.options.stepUp).toFixed(2)),
      );
    }

    if (next === null || next === this.currentScale) {
      return null;
    }

    this.currentScale = next;
    this.windowsSinceChange = 0;
    this.adjustments += 1;
    return next;
  }
}

/** 单个画质档位在给定视口下的最终 renderScale（含像素上限）。 */
export function resolvePresetRenderScale(
  level: Exclude<QualityLevel, "auto">,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const cap = maxScaleForPixels(cssWidth, cssHeight, devicePixelRatio);
  return Math.min(cap, QUALITY_PRESETS[level].renderScale * cap);
}
