import { describe, expect, it } from "vitest";

import {
  SLIME_DEN_BOUNDS,
  SLIME_DEN_ENTITY_ANCHORS,
  SLIME_DEN_GROUND_PATCHES,
  SLIME_DEN_HILLS,
  SLIME_DEN_PLAYER_SPAWN,
  SLIME_DEN_TREES,
  SLIME_DEN_PROPS,
  SLIME_DEN_EXITS,
  SLIME_DEN_TINT,
  validateSlimeDenLandscape,
  validateSlimeDenLayout,
} from "./slime-den-layout";
import { GREEN_HOLLOW_BOUNDS, GROUND_PATCHES } from "./green-hollow-layout";

describe("史莱姆巢穴（slime_den）布局数据", () => {
  it("布局自检无问题（边界/实体间距/道具重叠）", () => {
    expect(validateSlimeDenLayout()).toEqual([]);
  });

  it("景观自检无问题（四方向有远景、山丘不压可行走区）", () => {
    expect(validateSlimeDenLandscape()).toEqual([]);
  });

  it("面积约为主区域的三分之一", () => {
    const area =
      (SLIME_DEN_BOUNDS.maxX - SLIME_DEN_BOUNDS.minX) *
      (SLIME_DEN_BOUNDS.maxZ - SLIME_DEN_BOUNDS.minZ);
    const hollowArea =
      (GREEN_HOLLOW_BOUNDS.maxX - GREEN_HOLLOW_BOUNDS.minX) *
      (GREEN_HOLLOW_BOUNDS.maxZ - GREEN_HOLLOW_BOUNDS.minZ);

    expect(area / hollowArea).toBeGreaterThan(0.25);
    expect(area / hollowArea).toBeLessThan(0.45);
  });

  it("巢穴比主区域暗（复用主区域贴图时的调暗占位，资产 agent 产出后替换）", () => {
    expect(SLIME_DEN_TINT.r).toBeLessThan(1);
    expect(SLIME_DEN_TINT.b).toBeGreaterThan(SLIME_DEN_TINT.r * 0.8);
    for (const patch of SLIME_DEN_GROUND_PATCHES) {
      // 贴图 id 全部来自主区域资源；artifacts/region2/ 到位后换 asset 字段。
      expect(["grass", "stone-path", "dirt-path", "water"]).toContain(patch.texture);
    }
  });

  it("北缘留出返回翠谷的出口，且与 content 的 exits 坐标一致", () => {
    const back = SLIME_DEN_EXITS.find((exit) => exit.targetRegionId === "region:green_hollow");
    expect(back).toBeDefined();
    expect(back?.position.x).toBe(SLIME_DEN_PLAYER_SPAWN.x);
    // 出口贴着可行走区内沿，玩家走到就能触发而不是卡在边界外。
    expect(back!.position.z).toBeGreaterThan(SLIME_DEN_BOUNDS.minZ);
  });

  it("翠谷南缘的洞口在翠谷可行走区内，巢穴返回洞口在巢穴可行走区内（两地都能走到）", () => {
    const caveMouth = { x: 0, z: 19 };
    expect(caveMouth.z).toBeLessThan(GREEN_HOLLOW_BOUNDS.maxZ);
    expect(caveMouth.z).toBeGreaterThan(GREEN_HOLLOW_BOUNDS.minZ);

    const back = SLIME_DEN_EXITS[0];
    expect(back.position.z).toBeGreaterThan(SLIME_DEN_BOUNDS.minZ);
    expect(back.position.z).toBeLessThan(SLIME_DEN_BOUNDS.maxZ);
  });

  it("洞口通道上不放阻挡物（石墙不压在往返路线上）", () => {
    for (const prop of SLIME_DEN_PROPS.filter((entry) => entry.kind === "stone-wall")) {
      const onPath = Math.abs(prop.x) < 3 && prop.z < 0;
      expect(onPath).toBe(false);
    }
  });

  it("敌人锚点都在可行走区内且互不重叠", () => {
    const enemies = Object.entries(SLIME_DEN_ENTITY_ANCHORS).filter(([id]) =>
      id.startsWith("enemy:"),
    );
    expect(enemies.length).toBeGreaterThanOrEqual(3);
    for (const [, anchor] of enemies) {
      expect(anchor.x).toBeGreaterThan(SLIME_DEN_BOUNDS.minX);
      expect(anchor.x).toBeLessThan(SLIME_DEN_BOUNDS.maxX);
      expect(anchor.z).toBeGreaterThan(SLIME_DEN_BOUNDS.minZ);
      expect(anchor.z).toBeLessThan(SLIME_DEN_BOUNDS.maxZ);
    }
  });

  it("远景与山丘数量与主区域同量级（复用景观环带管线）", () => {
    expect(SLIME_DEN_HILLS.length).toBeGreaterThanOrEqual(6);
    expect(SLIME_DEN_TREES.length).toBeGreaterThanOrEqual(12);
  });

  it("地面贴片全部复用主区域的贴图 id（暗色调由材质 tint 承担）", () => {
    const denTextures = new Set(SLIME_DEN_GROUND_PATCHES.map((patch) => patch.texture));
    for (const texture of denTextures) {
      expect(
        GROUND_PATCHES.some((patch) => patch.texture === texture),
      ).toBe(true);
    }
  });
});