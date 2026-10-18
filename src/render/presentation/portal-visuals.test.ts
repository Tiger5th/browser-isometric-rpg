import { describe, expect, it } from "vitest";

import { EXIT_TRIGGER_RADIUS } from "../../logic/region-linkage";
import greenHollowRegion from "../../../content/regions/green_hollow.json";
import slimeDenRegion from "../../../content/regions/slime_den.json";
import { GROUND_PATCHES, GREEN_HOLLOW_BOUNDS } from "./green-hollow-layout";
import {
  PORTAL_GROUND_RING_RADIUS,
  advancePortalVisual,
  portalLabelFor,
  portalPartsFor,
} from "./portal-visuals";

/**
 * 票 37 验收修复：巢穴入口不可见。
 *
 * 复现：`exit:cave_mouth` 在 (0,19) 零视觉——没有洞口几何、没有地面提示，
 * ground.dirt.south 也没延伸到出口。玩家只能盲走撞区。
 */

const CAVE_MOUTH = greenHollowRegion.exits.find((exit) => exit.id === "exit:cave_mouth");

describe("区域出口的视觉标记", () => {
  it("翠谷的巢穴出口存在且在 (0,19)", () => {
    expect(CAVE_MOUTH).toBeDefined();
    expect(CAVE_MOUTH?.position).toEqual({ x: 0, y: 0, z: 19 });
    expect(CAVE_MOUTH?.targetRegionId).toBe("region:slime_den");
  });

  it("每个出口都被分配了洞口几何 + 地面圈 + 头顶标记 + 光环", () => {
    for (const region of [greenHollowRegion, slimeDenRegion]) {
      for (const exit of region.exits ?? []) {
        const kinds = portalPartsFor(exit.id, exit.position).map((part) => part.kind);
        expect(kinds).toEqual([
          "pillar-left",
          "pillar-right",
          "lintel",
          "ground-ring",
          "marker",
          "pulse",
        ]);
      }
    }
  });

  it("地面提示圈盖住触发半径（玩家站进圈里就该切区）", () => {
    expect(PORTAL_GROUND_RING_RADIUS).toBeGreaterThan(EXIT_TRIGGER_RADIUS);
  });

  it("巢穴出口的零件都落在出口坐标附近（不会画到别处）", () => {
    const parts = portalPartsFor("exit:cave_mouth", { x: 0, z: 19 });
    for (const part of parts) {
      expect(Math.abs(part.offset.x - 0)).toBeLessThanOrEqual(2.2);
      expect(Math.abs(part.offset.z - 19)).toBeLessThanOrEqual(0.01);
    }
  });

  it("头顶标记在门框之上（不会埋进洞里）", () => {
    const marker = portalPartsFor("exit:cave_mouth", { x: 0, z: 19 }).find(
      (part) => part.kind === "marker",
    );
    const lintel = portalPartsFor("exit:cave_mouth", { x: 0, z: 19 }).find(
      (part) => part.kind === "lintel",
    );
    expect(marker?.offset.y).toBeGreaterThan(lintel?.offset.y ?? 0);
  });

  it("巢穴出口有可读的名字（头顶标记文案）", () => {
    expect(portalLabelFor("exit:cave_mouth")).toBe("史莱姆巢穴");
    // 未知 id 回落到尾段，不会渲染出 undefined。
    expect(portalLabelFor("exit:something_else")).toBe("something_else");
  });

  it("advancePortalVisual 在无视觉件时是安全的空操作（冒烟可脱钩调用）", () => {
    expect(() =>
      advancePortalVisual(
        { root: null as never, exitId: "exit:x", meshes: [], pulse: null, marker: null, phase: 0 },
        1_000,
        16,
      ),
    ).not.toThrow();
  });
});

describe("通往巢穴的土路", () => {
  it("ground.dirt.south 从广场一路铺到出口 (0,19)", () => {
    const path = GROUND_PATCHES.find((patch) => patch.id === "ground.dirt.south");
    expect(path).toBeDefined();
    if (path === undefined) {
      return;
    }
    // x 对齐出口（出口在 x=0）：路面宽度 3.2，中心应落在 x≈0。
    expect(Math.abs(path.x + path.width / 2)).toBeLessThanOrEqual(2);
    // 路面覆盖到出口触发半径之外一点（出口 19，触发半径 1.6）。
    expect(path.z + path.depth / 2).toBeGreaterThanOrEqual(19 - EXIT_TRIGGER_RADIUS);
    // 又不能铺出区域边界。
    expect(path.z + path.depth / 2).toBeLessThanOrEqual(GREEN_HOLLOW_BOUNDS.maxZ);
  });
});
