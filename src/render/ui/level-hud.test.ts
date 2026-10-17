/**
 * 票 34：HUD 等级徽标的显示值。接缝 = levelHudView()（纯函数，DOM 之外的换算层）。
 */

import { describe, expect, it } from "vitest";

import type { LevelCurveDefinition } from "../../logic/leveling";
import { levelHudView } from "./level-hud";

const CURVE: LevelCurveDefinition = {
  id: "level_curve:standard",
  displayName: "标准曲线",
  defaultModifiers: [
    { attribute: "attack", operation: "add", value: 2 },
    { attribute: "defense", operation: "add", value: 2 },
    { attribute: "maxHp", operation: "add", value: 10 },
  ],
  levels: [
    { level: 1, xpRequired: 0 },
    { level: 2, xpRequired: 100 },
    { level: 3, xpRequired: 250 },
    { level: 4, xpRequired: 450 },
  ],
};

describe("HUD 等级徽标", () => {
  it("按累计经验显示等级徽标与经验条比例", () => {
    expect(levelHudView({ xp: 0 }, CURVE)).toMatchObject({
      level: 1,
      badge: "Lv.1",
      xpRatio: 0,
      xpText: "经验 0 / 100",
    });
    expect(levelHudView({ xp: 50 }, CURVE)).toMatchObject({
      level: 1,
      xpRatio: 0.5,
      xpText: "经验 50 / 100",
    });
    expect(levelHudView({ xp: 260 }, CURVE)).toMatchObject({
      level: 3,
      badge: "Lv.3",
      // L3 的经验条是本级区间 250 → 450 里的 10/200；文案分母是累计阈值 450。
      xpRatio: 0.05,
      xpText: "经验 260 / 450",
    });
  });

  it("满级时经验条按满格、文案说明已满级", () => {
    const view = levelHudView({ xp: 5_000 }, CURVE);
    expect(view.level).toBe(4);
    expect(view.xpToNext).toBeNull();
    expect(view.xpRatio).toBe(1);
    expect(view.maxed).toBe(true);
    expect(view.xpText).toBe("经验 5000（满级）");
  });

  it("没有曲线时回退到实体属性上的 level / xpToNext", () => {
    expect(levelHudView({ xp: 40, level: 3, xpToNext: 80 })).toMatchObject({
      level: 3,
      badge: "Lv.3",
      xpToNext: 80,
      xpRatio: 0.5,
      xpText: "经验 40 / 80",
    });
  });

  it("既没曲线也没 xpToNext 时经验条空、只显示数值，不谎称满级", () => {
    expect(levelHudView({ xp: 40 })).toMatchObject({
      level: 1,
      xpToNext: null,
      xpRatio: 0,
      maxed: false,
      xpText: "经验 40",
    });
  });

  it("经验比例夹在 0–1，负数与 NaN 不外泄", () => {
    expect(levelHudView({ xp: -5 }, CURVE).xpRatio).toBe(0);
    expect(levelHudView({ xp: Number.NaN }, CURVE).xpRatio).toBe(0);
  });
});