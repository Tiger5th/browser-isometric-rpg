import { describe, expect, it } from "vitest";

import {
  createAxisAlignedBox,
  createCameraAlignedBox,
  rayIntersectsOccluder,
} from "./ray-obb";

describe("射线-OBB（遮挡描边）", () => {
  it("轴对齐盒：正面射线命中", () => {
    const box = createAxisAlignedBox({ x: 0, y: 0, z: 0 }, 1, 1, 1);
    expect(
      rayIntersectsOccluder(0, 0, -5, 0, 0, 1, 30, box),
    ).toBe(true);
  });

  it("轴对齐盒：偏离目标不命中", () => {
    const box = createAxisAlignedBox({ x: 0, y: 0, z: 0 }, 1, 1, 1);
    expect(rayIntersectsOccluder(5, 0, -5, 0, 0, 1, 30, box)).toBe(false);
  });

  it("maxDistance 不足时不命中", () => {
    const box = createAxisAlignedBox({ x: 0, y: 0, z: 0 }, 1, 1, 1);
    expect(rayIntersectsOccluder(0, 0, -5, 0, 0, 1, 3, box)).toBe(false);
  });

  it("与轴平行且位于盒外的射线不命中", () => {
    const box = createAxisAlignedBox({ x: 0, y: 0, z: 0 }, 1, 1, 1);
    expect(rayIntersectsOccluder(2, 0, -5, 0, 0, 1, 30, box)).toBe(false);
  });

  it("盒子在射线起点后方不命中", () => {
    const box = createAxisAlignedBox({ x: 0, y: 0, z: 0 }, 1, 1, 1);
    expect(rayIntersectsOccluder(0, 0, 5, 0, 0, 1, 30, box)).toBe(false);
  });

  it("相机对齐盒：正对 billboard 命中，偏离不命中", () => {
    const forward = { x: 0, y: 0, z: 1 };
    const box = createCameraAlignedBox({ x: 0, y: 1, z: 0 }, forward, 1.5, 1.5, 0.2);
    expect(rayIntersectsOccluder(0, 1, -5, 0, 0, 1, 30, box)).toBe(true);
    expect(rayIntersectsOccluder(3, 1, -5, 0, 0, 1, 30, box)).toBe(false);
    expect(rayIntersectsOccluder(0, 4, -5, 0, 0, 1, 30, box)).toBe(false);
  });

  it("斜向相机对齐盒的轴保持正交归一", () => {
    const forward = { x: -1 / Math.SQRT2, y: -1 / Math.sqrt(3), z: 1 / Math.SQRT2 };
    const box = createCameraAlignedBox({ x: 0, y: 1, z: 0 }, forward, 1, 1, 0.2);
    const dot = (a: { x: number; y: number; z: number }, b: typeof a) =>
      a.x * b.x + a.y * b.y + a.z * b.z;
    const length = (a: typeof forward) => Math.hypot(a.x, a.y, a.z);

    expect(length(box.axisX)).toBeCloseTo(1, 6);
    expect(length(box.axisY)).toBeCloseTo(1, 6);
    expect(length(box.axisZ)).toBeCloseTo(1, 6);
    expect(dot(box.axisX, box.axisY)).toBeCloseTo(0, 6);
    expect(dot(box.axisX, box.axisZ)).toBeCloseTo(0, 6);
    expect(dot(box.axisY, box.axisZ)).toBeCloseTo(0, 6);
  });
});
