import { describe, expect, it } from "vitest";

import {
  boundsSize,
  createBoxGeometry,
  createBoxObstacleSpecs,
  createGroundGeometry,
  createRegionGeometry,
  createSeededRandom,
} from "./navmesh-geometry";

function triangleNormal(
  positions: readonly number[],
  indices: readonly number[],
  triangle: number,
): [number, number, number] {
  const [a, b, c] = [indices[triangle * 3], indices[triangle * 3 + 1], indices[triangle * 3 + 2]];
  const ax = positions[a * 3];
  const ay = positions[a * 3 + 1];
  const az = positions[a * 3 + 2];
  const bx = positions[b * 3] - ax;
  const by = positions[b * 3 + 1] - ay;
  const bz = positions[b * 3 + 2] - az;
  const cx = positions[c * 3] - ax;
  const cy = positions[c * 3 + 1] - ay;
  const cz = positions[c * 3 + 2] - az;
  return [by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx];
}

describe("createGroundGeometry", () => {
  it("produces upward-facing triangles covering the requested bounds", () => {
    const geometry = createGroundGeometry({ minX: -10, maxX: 10, minZ: -5, maxZ: 5 }, 2);

    expect(geometry.indices.length).toBe(2 * 2 * 2 * 3);
    for (let triangle = 0; triangle < geometry.indices.length / 3; triangle += 1) {
      const [, normalY, normalZ] = triangleNormal(geometry.positions, geometry.indices, triangle);
      expect(normalY).toBeGreaterThan(0);
      expect(normalZ).toBeCloseTo(0);
    }

    expect(Math.min(...geometry.positions.filter((_, index) => index % 3 === 0))).toBe(-10);
    expect(Math.max(...geometry.positions.filter((_, index) => index % 3 === 0))).toBe(10);
  });
});

describe("createBoxGeometry", () => {
  it("emits 12 triangles from below ground to the requested height", () => {
    const geometry = createBoxGeometry({
      name: "obstacle.test",
      x: 3,
      z: -2,
      width: 4,
      depth: 6,
      height: 3,
    });

    expect(geometry.positions.length).toBe(8 * 3);
    expect(geometry.indices.length).toBe(12 * 3);
    const ys = geometry.positions.filter((_, index) => index % 3 === 1);
    expect(Math.min(...ys)).toBe(-0.25);
    expect(Math.max(...ys)).toBe(3);
  });
});

describe("createBoxObstacleSpecs", () => {
  it("is deterministic and keeps obstacles inside bounds and outside exclusion zones", () => {
    const bounds = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
    const exclusion = { minX: -8, maxX: 8, minZ: -100, maxZ: 100 };
    const first = createBoxObstacleSpecs(bounds, 20, 42, { exclusionZones: [exclusion] });
    const second = createBoxObstacleSpecs(bounds, 20, 42, { exclusionZones: [exclusion] });

    expect(first).toEqual(second);
    expect(first.length).toBe(20);
    for (const spec of first) {
      expect(spec.x - spec.width / 2).toBeGreaterThanOrEqual(bounds.minX);
      expect(spec.x + spec.width / 2).toBeLessThanOrEqual(bounds.maxX);
      expect(spec.z - spec.depth / 2).toBeGreaterThanOrEqual(bounds.minZ);
      expect(spec.z + spec.depth / 2).toBeLessThanOrEqual(bounds.maxZ);
      const overlapsExclusion =
        spec.x + spec.width / 2 > exclusion.minX &&
        spec.x - spec.width / 2 < exclusion.maxX &&
        spec.z + spec.depth / 2 > exclusion.minZ &&
        spec.z - spec.depth / 2 < exclusion.maxZ;
      expect(overlapsExclusion).toBe(false);
    }
  });
});

describe("createSeededRandom", () => {
  it("repeats the same sequence for the same seed", () => {
    const left = createSeededRandom(7);
    const right = createSeededRandom(7);
    expect([left(), left(), left()]).toEqual([right(), right(), right()]);
  });
});

describe("createRegionGeometry", () => {
  it("merges ground and obstacle triangles with rebased indices", () => {
    const geometry = createRegionGeometry(
      { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      [{ name: "obstacle.test", x: 0, z: 0, width: 2, depth: 2, height: 2 }],
      2,
    );

    expect(geometry.indices.length).toBe((8 + 12) * 3);
    expect(Math.max(...geometry.indices)).toBe(16);
    expect(boundsSize({ minX: -10, maxX: 10, minZ: -10, maxZ: 10 }).area).toBe(400);
  });
});
