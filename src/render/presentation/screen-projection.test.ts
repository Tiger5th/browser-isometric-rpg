import { describe, expect, it } from "vitest";

import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import {
  cssViewportScale,
  projectWorldToCss,
  projectionViewportOf,
  renderToCss,
} from "./screen-projection";

/**
 * 票 37 验收修复：气泡飘离 NPC 头顶。
 *
 * 复现：投影用 engine.getRenderWidth/Height（渲染像素，含 renderScale×dpr），
 * 而 DOM 气泡用 CSS 像素定位。高画质（renderScale=1、dpr=2）下差 2 倍。
 */

describe("渲染像素视口 → CSS 像素视口", () => {
  it("高画质（dpr 2）系数为 1/2", () => {
    const scale = cssViewportScale({
      renderWidth: 3840,
      renderHeight: 2160,
      cssWidth: 1920,
      cssHeight: 1080,
    });
    expect(scale.x).toBeCloseTo(0.5, 6);
    expect(scale.y).toBeCloseTo(0.5, 6);
  });

  it("renderScale 0.75 + dpr 1 的组合系数为 1/0.75", () => {
    const scale = cssViewportScale({
      renderWidth: 1440,
      renderHeight: 810,
      cssWidth: 1920,
      cssHeight: 1080,
    });
    expect(scale.x).toBeCloseTo(1 / 0.75, 6);
  });

  it("画布未布局（尺寸为 0）时回退成 1，不产生 NaN/Infinity", () => {
    const scale = cssViewportScale({
      renderWidth: 0,
      renderHeight: 0,
      cssWidth: 0,
      cssHeight: 0,
    });
    expect(scale.x).toBe(1);
    expect(scale.y).toBe(1);
    expect(Number.isFinite(scale.x)).toBe(true);
  });

  it("renderToCss 把渲染坐标缩回 CSS 坐标", () => {
    const viewport = {
      renderWidth: 3840,
      renderHeight: 2160,
      cssWidth: 1920,
      cssHeight: 1080,
    };
    expect(renderToCss({ x: 2000, y: 1200 }, viewport)).toEqual({ x: 1000, y: 600 });
  });
});

describe("世界坐标 → CSS 像素投影", () => {
  /** 单位正交矩阵：投影结果等于世界坐标 + 视口半宽/半高偏移。 */
  const identity = Matrix.Identity();

  it("按 CSS 视口投影：视口中心对应世界原点", () => {
    const point = projectWorldToCss(
      Vector3.Zero(),
      identity,
      { renderWidth: 3840, renderHeight: 2160, cssWidth: 1920, cssHeight: 1080 },
    );
    expect(point.x).toBeCloseTo(960, 4);
    expect(point.y).toBeCloseTo(540, 4);
  });

  it("CSS 视口缩放不影响投影结果（比例已在视口里消化）", () => {
    const viewport = { renderWidth: 3840, renderHeight: 2160, cssWidth: 1920, cssHeight: 1080 };
    const high = projectWorldToCss(new Vector3(1, 0, 0), identity, viewport);
    // 同样的 CSS 视口，渲染尺寸改成 1×（renderScale→0）投影仍相同。
    const tiny = projectWorldToCss(new Vector3(1, 0, 0), identity, {
      ...viewport,
      renderWidth: 1920,
      renderHeight: 1080,
    });
    expect(high.x).toBeCloseTo(tiny.x, 4);
    expect(high.y).toBeCloseTo(tiny.y, 4);
  });

  it("世界点在视口上方时 CSS y 更小（屏幕 y 轴向下，投影应翻过来）", () => {
    const viewport = { renderWidth: 1920, renderHeight: 1080, cssWidth: 1920, cssHeight: 1080 };
    const origin = projectWorldToCss(Vector3.Zero(), identity, viewport);
    const up = projectWorldToCss(new Vector3(0, 10, 0), identity, viewport);
    expect(up.y).toBeLessThan(origin.y);
  });

  it("projectionViewportOf 优先用画布 clientWidth，缺失时回退引擎尺寸", () => {
    const viewport = projectionViewportOf(
      { getRenderWidth: () => 3840, getRenderHeight: () => 2160 },
      { clientWidth: 1920, clientHeight: 1080 },
    );
    expect(viewport).toEqual({
      renderWidth: 3840,
      renderHeight: 2160,
      cssWidth: 1920,
      cssHeight: 1080,
    });

    const fallback = projectionViewportOf(
      { getRenderWidth: () => 1280, getRenderHeight: () => 720 },
      null,
    );
    expect(fallback.cssWidth).toBe(1280);
    expect(fallback.cssHeight).toBe(720);
  });

  it("画布存在但 clientWidth 为 0（未布局）时回退引擎尺寸", () => {
    const viewport = projectionViewportOf(
      { getRenderWidth: () => 1280, getRenderHeight: () => 720 },
      { clientWidth: 0, clientHeight: 0 },
    );
    expect(viewport.cssWidth).toBe(1280);
    expect(cssViewportScale(viewport)).toEqual({ x: 1, y: 1 });
  });
});
