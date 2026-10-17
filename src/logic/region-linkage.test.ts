import { describe, expect, it } from "vitest";

import {
  EXIT_TRIGGER_RADIUS,
  findTriggeredExit,
  type RegionLinkageExit,
} from "./region-linkage";

const EXITS: readonly RegionLinkageExit[] = [
  { id: "exit:cave_mouth", targetRegionId: "region:slime_den", position: { x: 0, y: 0, z: 19 } },
];

describe("区域联动：出口触发判定", () => {
  it("玩家走到路口（半径内）时触发该出口", () => {
    const triggered = findTriggeredExit(EXITS, { x: 0, z: 19 });

    expect(triggered?.id).toBe("exit:cave_mouth");
    expect(triggered?.targetRegionId).toBe("region:slime_den");
  });

  it("玩家还没走到路口时不触发", () => {
    expect(findTriggeredExit(EXITS, { x: 0, z: 10 })).toBeNull();
  });

  it("判定边界是半径本身：刚好等于半径触发，超出一点点就不触发", () => {
    // 用整数半径避免浮点误差把「刚好等于」变成「差一个 ulp」。
    expect(findTriggeredExit(EXITS, { x: 0, z: 21 }, 2)?.id).toBe("exit:cave_mouth");
    expect(findTriggeredExit(EXITS, { x: 0, z: 21.01 }, 2)).toBeNull();
  });

  it("默认半径覆盖路口本身的宽度（翠谷南缘路口距出生点 19m）", () => {
    expect(findTriggeredExit(EXITS, { x: 0, z: 19 + EXIT_TRIGGER_RADIUS - 0.01 })?.id).toBe(
      "exit:cave_mouth",
    );
  });

  it("多个出口同时在半径内时取最近的一个，与数组顺序无关", () => {
    const exits: readonly RegionLinkageExit[] = [
      { id: "exit:far", targetRegionId: "region:far", position: { x: 5, y: 0, z: 0 } },
      { id: "exit:near", targetRegionId: "region:near", position: { x: 0, y: 0, z: 0 } },
    ];

    expect(findTriggeredExit(exits, { x: 0, z: 0 })?.id).toBe("exit:near");
    expect(findTriggeredExit([...exits].reverse(), { x: 0, z: 0 })?.id).toBe("exit:near");
  });

  it("出口清单为空时永不触发", () => {
    expect(findTriggeredExit([], { x: 0, z: 0 })).toBeNull();
  });

  it("触发半径非法时显式报错，不静默当成无限大", () => {
    expect(() => findTriggeredExit(EXITS, { x: 0, z: 0 }, 0)).toThrow(/半径/);
    expect(() => findTriggeredExit(EXITS, { x: 0, z: 0 }, Number.NaN)).toThrow(/半径/);
  });
});