/**
 * 相机自由化 L1 断言（票 37）：缩放范围、旋转夹取、一键复位回出厂预设。
 *
 * 用一个形状与 ArcRotateCamera 一致的假相机（不实例化 Babylon 场景），
 * 让这些纯数值逻辑可以在 vitest 里直测。
 */

import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { describe, expect, it } from "vitest";

import { cameraVerticalSpan, ISOMETRIC_ALPHA, ISOMETRIC_BETA, ISOMETRIC_RADIUS } from "./camera";
import {
  CAMERA_PRESETS,
  ISOMETRIC_PRESET,
  MAX_CAMERA_BETA,
  MAX_CAMERA_VERTICAL_SPAN,
  MIN_CAMERA_BETA,
  MIN_CAMERA_VERTICAL_SPAN,
  CAMERA_RESET_DURATION_MS,
  advanceCameraReset,
  applyCameraRotate,
  applyCameraZoom,
  applyPreset,
  beginCameraReset,
  cameraPreset,
  normalizeAlpha,
  shortestAngleDelta,
} from "./camera-presets";

const ASPECT = 16 / 9;

function fakeCamera(): ArcRotateCamera {
  return {
    alpha: ISOMETRIC_ALPHA,
    beta: ISOMETRIC_BETA,
    radius: ISOMETRIC_RADIUS,
    metadata: null,
    orthoTop: 0,
    orthoBottom: 0,
    orthoLeft: 0,
    orthoRight: 0,
  } as unknown as ArcRotateCamera;
}

describe("相机预设位（票 37）", () => {
  it("出厂等距预设就是票 28 的锁死视角常量", () => {
    expect(ISOMETRIC_PRESET.alpha).toBe(ISOMETRIC_ALPHA);
    expect(ISOMETRIC_PRESET.beta).toBe(ISOMETRIC_BETA);
    expect(ISOMETRIC_PRESET.radius).toBe(ISOMETRIC_RADIUS);
    expect(ISOMETRIC_PRESET.verticalSpan).toBe(20);
  });

  it("预设表支持多预设位（当前只有出厂一位）", () => {
    expect(Object.keys(CAMERA_PRESETS)).toEqual(["isometric"]);
    expect(cameraPreset("isometric")).toBe(ISOMETRIC_PRESET);
    expect(() => cameraPreset("topdown")).toThrow(/未知相机预设/);
  });

  it("normalizeAlpha 把任意角度折到 (−π, π]，复位不绕远路", () => {
    expect(normalizeAlpha(ISOMETRIC_ALPHA)).toBeCloseTo(ISOMETRIC_ALPHA, 10);
    expect(normalizeAlpha(ISOMETRIC_ALPHA + Math.PI * 2)).toBeCloseTo(ISOMETRIC_ALPHA, 10);
    expect(normalizeAlpha(-Math.PI * 1.5)).toBeCloseTo(Math.PI * 0.5, 10);
    // 从 −3 走到 +3：最短路是 +0.28 而不是 −6.0。
    expect(shortestAngleDelta(-3, 3)).toBeCloseTo(6 - Math.PI * 2, 10);
  });
});

describe("滚轮缩放（有限范围）", () => {
  it("向上滚拉近、向下滚拉远，可视高度按步长变化", () => {
    const camera = fakeCamera();
    expect(applyCameraZoom(camera, -1, 20, ASPECT)).toBe(true);
    expect(cameraVerticalSpan(camera)).toBe(16);
    applyCameraZoom(camera, 1, 20, ASPECT);
    expect(cameraVerticalSpan(camera)).toBe(20);
  });

  it("缩到/放到范围两端即夹住，不会无限缩", () => {
    const camera = fakeCamera();
    for (let i = 0; i < 20; i += 1) {
      applyCameraZoom(camera, -1, 20, ASPECT);
    }
    expect(cameraVerticalSpan(camera)).toBe(MIN_CAMERA_VERTICAL_SPAN);
    for (let i = 0; i < 40; i += 1) {
      applyCameraZoom(camera, 1, 20, ASPECT);
    }
    expect(cameraVerticalSpan(camera)).toBe(MAX_CAMERA_VERTICAL_SPAN);
  });

  it("已在端点继续滚不产生变化（同值返回 false）", () => {
    const camera = fakeCamera();
    applyCameraZoom(camera, -50, 20, ASPECT);
    expect(cameraVerticalSpan(camera)).toBe(MIN_CAMERA_VERTICAL_SPAN);
    expect(applyCameraZoom(camera, -1, 20, ASPECT)).toBe(false);
    expect(applyCameraZoom(camera, 0, 20, ASPECT)).toBe(false);
  });

  it("缩放同步正交视锥（orthoTop 随 span 变）", () => {
    const camera = fakeCamera();
    applyCameraZoom(camera, -1, 20, ASPECT);
    expect(camera.orthoTop).toBe(8);
    expect(camera.orthoBottom).toBe(-8);
  });
});

describe("拖拽旋转（有限范围）", () => {
  it("水平拖拽改 alpha，垂直拖拽改 beta", () => {
    const camera = fakeCamera();
    applyCameraRotate(camera, 100, 0);
    expect(camera.alpha).toBeCloseTo(ISOMETRIC_ALPHA + 0.8, 10);

    applyCameraRotate(camera, 0, 10);
    expect(camera.beta).toBeCloseTo(ISOMETRIC_BETA - 0.08, 10);
  });

  it("beta 夹在范围内（不会转到地平线以下或天顶）", () => {
    const camera = fakeCamera();
    applyCameraRotate(camera, 0, 100_000);
    expect(camera.beta).toBe(MIN_CAMERA_BETA);
    applyCameraRotate(camera, 0, -100_000);
    expect(camera.beta).toBe(MAX_CAMERA_BETA);
  });

  it("alpha 始终归一化在 (−π, π]，绕一整圈不会溢出", () => {
    const camera = fakeCamera();
    for (let i = 0; i < 100; i += 1) {
      applyCameraRotate(camera, 50, 0);
    }
    expect(camera.alpha).toBeGreaterThan(-Math.PI);
    expect(camera.alpha).toBeLessThanOrEqual(Math.PI);
  });

  it("零位移不改动相机", () => {
    const camera = fakeCamera();
    expect(applyCameraRotate(camera, 0, 0)).toBe(false);
    expect(camera.alpha).toBe(ISOMETRIC_ALPHA);
  });
});

describe("一键复位回出厂等距预设（平滑插值）", () => {
  it("多步插值后精确落回预设值（alpha/beta/radius/span）", () => {
    const camera = fakeCamera();
    // 先自由缩放 + 旋转。
    applyCameraZoom(camera, -3, 20, ASPECT);
    applyCameraRotate(camera, 300, -200);
    expect(cameraVerticalSpan(camera)).not.toBe(ISOMETRIC_PRESET.verticalSpan);
    expect(camera.alpha).not.toBeCloseTo(ISOMETRIC_PRESET.alpha, 5);

    let settled = false;
    let elapsed = 0;
    const start = beginCameraReset(camera, ISOMETRIC_PRESET, 20);
    while (!settled && elapsed <= 2000) {
      settled = advanceCameraReset(camera, start, ISOMETRIC_PRESET, elapsed, ASPECT);
      elapsed += 16;
    }

    expect(settled).toBe(true);
    expect(elapsed).toBeGreaterThan(16); // 确实是插值而不是瞬移。
    // 插值时长就是 CAMERA_RESET_DURATION_MS（不靠「多跑几秒慢慢逼近」）。
    expect(elapsed).toBeLessThanOrEqual(CAMERA_RESET_DURATION_MS + 32);
    expect(camera.alpha).toBe(ISOMETRIC_PRESET.alpha);
    expect(camera.beta).toBe(ISOMETRIC_PRESET.beta);
    expect(camera.radius).toBe(ISOMETRIC_PRESET.radius);
    expect(cameraVerticalSpan(camera)).toBe(ISOMETRIC_PRESET.verticalSpan);
  });

  it("单帧超长 dt 直接到位（切标签页回来不会卡在中途）", () => {
    const camera = fakeCamera();
    applyCameraRotate(camera, 500, 500);
    const start = beginCameraReset(camera, ISOMETRIC_PRESET, 20);
    expect(advanceCameraReset(camera, start, ISOMETRIC_PRESET, 5000, ASPECT)).toBe(true);
    expect(camera.alpha).toBe(ISOMETRIC_PRESET.alpha);
  });

  it("已经在预设位时复位是幂等的", () => {
    const camera = fakeCamera();
    const start = beginCameraReset(camera, ISOMETRIC_PRESET, 20);
    expect(advanceCameraReset(camera, start, ISOMETRIC_PRESET, 16, ASPECT)).toBe(true);
    expect(advanceCameraReset(camera, start, ISOMETRIC_PRESET, 16, ASPECT)).toBe(true);
    expect(camera.alpha).toBe(ISOMETRIC_PRESET.alpha);
  });

  it("applyPreset 是立即复位（复位第一帧用），并同步视锥", () => {
    const camera = fakeCamera();
    applyCameraZoom(camera, 2, 20, ASPECT);
    applyPreset(camera, ISOMETRIC_PRESET, ASPECT);
    expect(cameraVerticalSpan(camera)).toBe(ISOMETRIC_PRESET.verticalSpan);
    expect(camera.orthoTop).toBe(ISOMETRIC_PRESET.verticalSpan / 2);
  });

  it("复位走最短角路而不是绕远路", () => {
    const camera = fakeCamera();
    camera.alpha = ISOMETRIC_PRESET.alpha + Math.PI * 1.9;
    camera.alpha = normalizeAlpha(camera.alpha);
    // 1.9π 归一化后是 −0.1π，最短路是 +0.1π。
    expect(Math.abs(shortestAngleDelta(camera.alpha, ISOMETRIC_PRESET.alpha))).toBeLessThan(0.5);
    let settled = false;
    let elapsed = 0;
    const start = beginCameraReset(camera, ISOMETRIC_PRESET, 20);
    while (!settled && elapsed <= 2000) {
      settled = advanceCameraReset(camera, start, ISOMETRIC_PRESET, elapsed, ASPECT);
      elapsed += 16;
    }
    expect(settled).toBe(true);
    // 全程 alpha 单调走向 −0.7854：1.9π 归一化后是 −0.1π，最短路 +0.1π。
    expect(camera.alpha).toBeCloseTo(ISOMETRIC_PRESET.alpha, 6);
  });
});