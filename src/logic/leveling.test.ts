/**
 * 等级曲线（票 34）L1：累计经验 → 等级、距下一级、每级属性加成。
 *
 * 期望值取自 content/level-curves/standard.json 的初版曲线（L2=100、L3=250、L4=450），
 * 是独立的合同数值，不是把实现算一遍。
 */

import { describe, expect, it } from "vitest";

import {
  levelForXp,
  nextLevelThreshold,
  levelProgressRatio,
  modifiersForLevel,
  resolveLevelProgress,
  validateLevelCurve,
  xpToNextLevel,
  type LevelCurveDefinition,
} from "./leveling";

/** 合同曲线：与 content/level-curves/standard.json 一致（每级 +2 攻 +2 防 +10 HP）。 */
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

describe("等级曲线：累计经验换算等级", () => {
  it("阈值以下保持 1 级，阈值当刻进位", () => {
    expect(levelForXp(CURVE, 0)).toBe(1);
    expect(levelForXp(CURVE, 99)).toBe(1);
    expect(levelForXp(CURVE, 100)).toBe(2);
    expect(levelForXp(CURVE, 249)).toBe(2);
    expect(levelForXp(CURVE, 250)).toBe(3);
    expect(levelForXp(CURVE, 449)).toBe(3);
    expect(levelForXp(CURVE, 450)).toBe(4);
  });

  it("一次跨过多级时取最高满足的等级", () => {
    expect(levelForXp(CURVE, 449)).toBe(3);
    expect(levelForXp(CURVE, 100_000)).toBe(4);
  });

  it("距下一级的经验随升级重算，满级为 null", () => {
    expect(xpToNextLevel(CURVE, 1, 0)).toBe(100);
    expect(xpToNextLevel(CURVE, 1, 60)).toBe(40);
    expect(xpToNextLevel(CURVE, 2, 100)).toBe(150);
    expect(xpToNextLevel(CURVE, 4, 900)).toBeNull();
    expect(nextLevelThreshold(CURVE, 2)).toBe(250);
    expect(nextLevelThreshold(CURVE, 4)).toBeNull();
  });
});

describe("等级曲线：属性加成入账", () => {
  it("1 级不加属性，每升一级叠加一份默认加成", () => {
    expect(modifiersForLevel(CURVE, 1)).toEqual([]);
    // L3 = 升了 2 级 → 两份加成。
    expect(modifiersForLevel(CURVE, 3)).toHaveLength(6);
    expect(modifiersForLevel(CURVE, 3)).toEqual(
      Array(2).fill([
        { attribute: "attack", operation: "add", value: 2 },
        { attribute: "defense", operation: "add", value: 2 },
        { attribute: "maxHp", operation: "add", value: 10 },
      ]).flat(),
    );
  });

  it("单级可覆盖默认加成", () => {
    const curve: LevelCurveDefinition = {
      ...CURVE,
      levels: [
        { level: 1, xpRequired: 0 },
        {
          level: 2,
          xpRequired: 100,
          modifiers: [{ attribute: "attack", operation: "multiply", value: 0.5 }],
        },
      ],
    };
    expect(modifiersForLevel(curve, 2)).toEqual([
      { attribute: "attack", operation: "multiply", value: 0.5 },
    ]);
  });

  it("resolveLevelProgress 一次给出 HUD 需要的全部字段", () => {
    expect(resolveLevelProgress(CURVE, 260)).toEqual({
      level: 3,
      cumulativeXp: 260,
      xpToNext: 190,
      nextThreshold: 450,
      modifiers: expect.arrayContaining([
        { attribute: "attack", operation: "add", value: 2 },
      ]),
    });
  });
});

describe("等级曲线：经验条进度按本级区间算", () => {
  it("刚进级时进度接近 0，不跳到满格", () => {
    expect(levelProgressRatio(CURVE, 250)).toBe(0);
    expect(levelProgressRatio(CURVE, 350)).toBe(0.5);
    expect(levelProgressRatio(CURVE, 449)).toBeCloseTo(0.995);
  });

  it("满级为 1，负数/NaN 夹在 0", () => {
    expect(levelProgressRatio(CURVE, 900)).toBe(1);
    expect(levelProgressRatio(CURVE, -10)).toBe(0);
    expect(levelProgressRatio(CURVE, Number.NaN)).toBe(0);
  });
});

describe("等级曲线：结构校验（L2 与逻辑层共用）", () => {
  it("合同曲线合法", () => {
    expect(validateLevelCurve(CURVE)).toEqual([]);
  });

  it("拒绝非递增阈值与不连续的等级序号", () => {
    expect(
      validateLevelCurve({
        ...CURVE,
        levels: [
          { level: 1, xpRequired: 0 },
          { level: 2, xpRequired: 250 },
          { level: 3, xpRequired: 100 },
        ],
      }).join("|"),
    ).toContain("严格大于上一级");

    expect(
      validateLevelCurve({
        ...CURVE,
        levels: [
          { level: 1, xpRequired: 0 },
          { level: 3, xpRequired: 100 },
        ],
      }).join("|"),
    ).toContain("连续递增");
  });

  it("拒绝首级非 0 经验、空等级表与缺省加成", () => {
    expect(
      validateLevelCurve({
        ...CURVE,
        levels: [
          { level: 1, xpRequired: 10 },
          { level: 2, xpRequired: 100 },
        ],
      }).join("|"),
    ).toContain("levels[0].xpRequired 必须为 0");

    expect(validateLevelCurve({ ...CURVE, levels: [] }).join("|")).toContain("levels 不能为空");
    expect(validateLevelCurve({ ...CURVE, defaultModifiers: [] }).join("|")).toContain(
      "defaultModifiers",
    );
    expect(validateLevelCurve(null)).toEqual(["等级曲线必须是对象"]);
  });
});