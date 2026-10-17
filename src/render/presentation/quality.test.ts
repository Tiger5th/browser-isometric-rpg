import { describe, expect, it } from "vitest";

import {
  DEFAULT_DYNAMIC_RESOLUTION,
  DynamicResolutionController,
  QUALITY_PRESETS,
  maxScaleForPixels,
  parseQualityLevel,
  renderScaleToHardwareScaling,
  resolvePresetRenderScale,
  TARGET_RENDER_PIXELS,
} from "./quality";

describe("画质档位", () => {
  it("默认 query 回落到 auto，非法值同样回落", () => {
    expect(parseQualityLevel(null)).toBe("auto");
    expect(parseQualityLevel(undefined)).toBe("auto");
    expect(parseQualityLevel("ultra")).toBe("auto");
    expect(parseQualityLevel("low")).toBe("low");
  });

  it("high/medium/low 的渲染倍率依次降低", () => {
    expect(QUALITY_PRESETS.high.renderScale).toBeGreaterThan(
      QUALITY_PRESETS.medium.renderScale,
    );
    expect(QUALITY_PRESETS.medium.renderScale).toBeGreaterThan(
      QUALITY_PRESETS.low.renderScale,
    );
  });

  it("1080p 视口在 DPR=1 时可以用满 1.0 倍", () => {
    expect(maxScaleForPixels(1920, 1080, 1)).toBe(1);
  });

  it("高 DPR 视口按 1080p 像素上限降采样", () => {
    const scale = maxScaleForPixels(1920, 1080, 2);
    expect(scale).toBeCloseTo(0.5, 5);
    const pixels =
      1920 * 2 * scale * 1080 * 2 * scale;
    expect(pixels).toBeLessThanOrEqual(TARGET_RENDER_PIXELS + 1);
  });

  it("renderScale 换算成 Babylon hardwareScalingLevel", () => {
    expect(renderScaleToHardwareScaling(1, 1)).toBe(1);
    expect(renderScaleToHardwareScaling(1, 2)).toBe(0.5);
    expect(renderScaleToHardwareScaling(0.5, 1)).toBe(2);
  });

  it("低档位不会超过视口的像素上限", () => {
    const scale = resolvePresetRenderScale("low", 1920, 1080, 2);
    expect(scale).toBeCloseTo(0.3, 5);
  });
});

describe("动态分辨率控制器", () => {
  const options = {
    minScale: 0.6,
    maxScale: 1,
    decreaseFrameMs: 17.5,
    increaseFrameMs: 14.5,
    stepDown: 0.1,
    stepUp: 0.05,
    windowSize: 10,
    warmupFrames: 5,
    cooldownWindows: 1,
  };

  function feed(
    controller: DynamicResolutionController,
    frameMs: number,
    windows: number,
  ): number | null {
    let last: number | null = null;
    for (let index = 0; index < windows * options.windowSize; index += 1) {
      last = controller.sample(frameMs) ?? last;
    }
    return last;
  }

  it("60fps 左右保持当前倍率", () => {
    const controller = new DynamicResolutionController(1, options);
    expect(feed(controller, 16.7, 4)).toBeNull();
    expect(controller.scale).toBe(1);
  });

  it("持续掉帧会降档，且有下限", () => {
    const controller = new DynamicResolutionController(1, options);
    feed(controller, 25, 10);
    expect(controller.scale).toBe(options.minScale);
    expect(controller.adjustmentCount).toBeGreaterThan(0);
  });

  it("帧时间充裕时升档，且有上限", () => {
    const controller = new DynamicResolutionController(0.6, options);
    feed(controller, 10, 20);
    expect(controller.scale).toBe(options.maxScale);
  });

  it("不存在/非法帧时间被忽略", () => {
    const controller = new DynamicResolutionController(1, options);
    expect(controller.sample(0)).toBeNull();
    expect(controller.sample(Number.NaN)).toBeNull();
    expect(controller.scale).toBe(1);
  });

  it("预热帧不参与决策（避开首帧 shader 编译）", () => {
    const controller = new DynamicResolutionController(1, options);
    for (let index = 0; index < options.warmupFrames; index += 1) {
      controller.sample(100);
    }
    expect(controller.scale).toBe(1);
    feed(controller, 100, 2);
    expect(controller.scale).toBeLessThan(1);
  });

  it("调整后进入冷却窗口，不会连续两个窗口都降档", () => {
    const controller = new DynamicResolutionController(1, options);
    // 预热 5 帧后，前 10 个采样窗口超阈值 -> 一次降档
    feed(controller, 100, 2);
    const afterFirst = controller.scale;
    expect(afterFirst).toBe(0.9);
    // 下一个窗口仍在冷却，不调整
    feed(controller, 100, 1);
    expect(controller.scale).toBe(afterFirst);
  });

  it("reset 恢复初始倍率并清空采样", () => {
    const controller = new DynamicResolutionController(1, options);
    feed(controller, 100, 3);
    controller.reset(0.8);
    expect(controller.scale).toBe(0.8);
    expect(controller.sample(16.7)).toBeNull();
  });

  it("默认参数是 P0 修正预算的保守值", () => {
    expect(DEFAULT_DYNAMIC_RESOLUTION.decreaseFrameMs).toBeGreaterThan(
      1000 / 60,
    );
    expect(DEFAULT_DYNAMIC_RESOLUTION.maxScale).toBe(1);
    expect(DEFAULT_DYNAMIC_RESOLUTION.minScale).toBeGreaterThanOrEqual(0.5);
  });
});
