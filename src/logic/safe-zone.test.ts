import { describe, expect, it } from "vitest";

import { insideAnySafeZone, insideSafeZone, safeZoneAt, type SafeZoneDefinition } from "./safe-zone";

const VILLAGE: SafeZoneDefinition = {
  id: "zone:village",
  shape: "rect",
  center: { x: 0, y: 0, z: 4 },
  halfExtents: { x: 8, z: 6 },
};

describe("安全区几何（票 33）", () => {
  it("矩形内与边缘上的点算安全区，矩形外一点算不安全", () => {
    expect(insideSafeZone(VILLAGE, { x: 0, y: 0, z: 4 })).toBe(true);
    // 边界含等号：围栏线本身仍在区内。
    expect(insideSafeZone(VILLAGE, { x: 8, y: 0, z: 4 })).toBe(true);
    expect(insideSafeZone(VILLAGE, { x: 8.5, y: 0, z: 4 })).toBe(false);
    expect(insideSafeZone(VILLAGE, { x: 0, y: 0, z: -2.5 })).toBe(false);
  });

  it("y 轴不参与判定（安全区是地面地带）", () => {
    expect(insideSafeZone(VILLAGE, { x: 1, y: 999, z: 1 })).toBe(true);
  });

  it("多安全区时任一命中即为安全；无安全区恒为否", () => {
    const outpost: SafeZoneDefinition = {
      id: "zone:outpost",
      shape: "rect",
      center: { x: 30, y: 0, z: -20 },
      halfExtents: { x: 4, z: 4 },
    };
    expect(insideAnySafeZone([VILLAGE, outpost], { x: 31, y: 0, z: -20 })).toBe(true);
    expect(insideAnySafeZone([VILLAGE, outpost], { x: 20, y: 0, z: -20 })).toBe(false);
    expect(insideAnySafeZone([], { x: 0, y: 0, z: 4 })).toBe(false);
  });

  it("safeZoneAt 返回点所在的安全区，不在区内为 null", () => {
    expect(safeZoneAt([VILLAGE], { x: 0, y: 0, z: 4 })?.id).toBe("zone:village");
    expect(safeZoneAt([VILLAGE], { x: 50, y: 0, z: 50 })).toBeNull();
  });
});
