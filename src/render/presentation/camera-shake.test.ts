/**
 * 震屏基准（review #6）：抖动不污染 camera.alpha 的基准。
 *
 * 累加式实现 `camera.alpha += jitter` 每帧把上次抖动当新基准，
 * 几十帧后视角被永久推歪；本测试钉住「基准 + jitter」的语义。
 */
import { describe, expect, it } from "vitest";

import { advanceCameraShake, resetCameraShake } from "./combat-feedback-core";

const BASE_ALPHA = Math.PI / 4;

describe("震屏基准", () => {
  it("抖动期间每帧都从基准重算，不逐帧累加", () => {
    let state = resetCameraShake();
    let alpha = BASE_ALPHA;

    for (let frame = 0; frame < 60; frame += 1) {
      const jitter = 0.02; // 固定抖动，累加式实现会一路偏向 +X
      const step = advanceCameraShake(state, alpha, jitter, true);
      alpha = step.alpha;
      state = step.state;
    }

    expect(alpha).toBeCloseTo(BASE_ALPHA + 0.02, 6);
  });

  it("抖动结束后 alpha 精确回到基准（不留在偏移上）", () => {
    const state = { baselineAlpha: BASE_ALPHA, lastJitter: 0.02, active: true };
    const step = advanceCameraShake(state, BASE_ALPHA + 0.02, 0, false);
    expect(step.alpha).toBe(BASE_ALPHA);
    expect(step.state.active).toBe(false);
  });

  it("抖动期间外部改了 alpha（自由相机）时以新值为基准", () => {
    const state = { baselineAlpha: BASE_ALPHA, lastJitter: 0.02, active: true };
    // 玩家拖拽把 alpha 改到 1.0（= 旧基准 + 0.02 + 玩家拖拽量）。
    const step = advanceCameraShake(state, 1.0, 0.01, true);
    // 新基准 = 当前值 - 上一帧抖动，抖动只叠加在玩家选定的视角上。
    expect(step.alpha).toBeCloseTo(0.98 + 0.01, 6);
    expect(step.state.baselineAlpha).toBeCloseTo(0.98, 6);
  });

  it("首次抖动直接取当前值为基准", () => {
    const step = advanceCameraShake(resetCameraShake(), BASE_ALPHA, 0.01, true);
    expect(step.state.baselineAlpha).toBe(BASE_ALPHA);
    expect(step.alpha).toBeCloseTo(BASE_ALPHA + 0.01, 6);
  });

  it("震屏关掉期间抖动不叠加（enable=false 时 alpha 不变）", () => {
    const state = { baselineAlpha: BASE_ALPHA, lastJitter: 0, active: false };
    const step = advanceCameraShake(state, BASE_ALPHA, 0.03, false);
    expect(step.alpha).toBe(BASE_ALPHA);
  });
});
