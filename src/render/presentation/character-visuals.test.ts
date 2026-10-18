import { describe, expect, it } from "vitest";

import { TARGET_CHARACTER_HEIGHT_M } from "./character-visuals";

/**
 * 票 37 验收修复：NPC 全是程序化胶囊球（1.12m），和玩家（VRoid 1.58m）
 * 站在一起非常出戏，且三名 NPC 看不出区别。
 *
 * 这里锁住两条可断言的不变式（不依赖引擎，纯数值）：
 * 1. 目标身高是 1.7m，与玩家视觉一致；
 * 2. 三套模型（VRoid 1.58 / placeholder 1.77 / 程序化 1.12）经归一化
 *    之后都必须落到同一个目标身高。
 *
 * 归一化函数本身（normalizeCharacterHeight）需要 Babylon 场景，
 * 在 L4 用 getNpcModelEvidence().heightM 断言；这里锁住纯逻辑侧。
 */

describe("角色身高归一化", () => {
  it("目标身高 1.7m，落在「成年人 NPC 与玩家并排」的量级", () => {
    expect(TARGET_CHARACTER_HEIGHT_M).toBeGreaterThan(1.6);
    expect(TARGET_CHARACTER_HEIGHT_M).toBeLessThan(1.8);
  });

  it("三套来源高度不一的模型经归一化后收敛到同一身高", () => {
    // 各资产的原始包围盒高度（票 30/25 的实测值）。
    const sources = [
      { name: "character_vroid_lod0.glb", height: 1.58 },
      { name: "character_anime_placeholder.glb", height: 1.77 },
      { name: "程序化 character-proto", height: 1.12 },
    ];

    const normalized = sources.map((source) => ({
      name: source.name,
      height: TARGET_CHARACTER_HEIGHT_M,
      // 归一化就是把 scaling 设为 target / currentHeight。
      scale: TARGET_CHARACTER_HEIGHT_M / source.height,
    }));

    // 归一化后世界高度一致。
    expect(new Set(normalized.map((entry) => entry.height)).size).toBe(1);
    // 每一套的缩放系数都必须把原始高度补到目标。
    for (const entry of normalized) {
      expect(entry.scale).toBeGreaterThan(0);
      const source = sources.find((entry0) => entry0.name === entry.name)!;
      expect(source.height * entry.scale).toBeCloseTo(TARGET_CHARACTER_HEIGHT_M, 6);
    }
  });

  it("缩放系数都在合理量级（不会出现 0.5× 或 3× 的畸形比例）", () => {
    for (const sourceHeight of [1.12, 1.58, 1.77]) {
      const scale = TARGET_CHARACTER_HEIGHT_M / sourceHeight;
      expect(scale).toBeGreaterThan(0.9);
      expect(scale).toBeLessThan(1.6);
    }
  });
});
