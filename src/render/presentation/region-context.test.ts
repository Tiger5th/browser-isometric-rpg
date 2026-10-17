/**
 * 区域上下文（code-review 修复）：切区收敛相关的纯函数。
 *
 * 这些规则原来散在 p1-world 的切区路径里、没有测试兜底：
 * - 切区必须把上一区域的 NPC/敌人视觉全部清掉（不能残留翠谷 mesh），
 *   新区域的敌人/NPC 必须重建视觉（玩家跨区域保留）；
 * - 区域相关 bounds 随切区更新（不再永远用翠谷）。
 */

import { describe, expect, it } from "vitest";

import type { EntitySnapshot } from "../../logic/game-session";
import { bushesOf, planEntityVisualRebuild } from "./region-context";
import { GREEN_HOLLOW_BOUNDS, PROPS, type PropPlacement } from "./green-hollow-layout";
import { SLIME_DEN_PROPS } from "./slime-den-layout";

function entity(
  id: string,
  type: "player" | "npc" | "enemy",
): EntitySnapshot {
  return {
    id,
    identity: { type, templateId: `template:${id}`, displayName: id },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    tags: [],
    movement: null,
    baseAttributes: {},
    attributes: {},
    modifiers: [],
    combat: {
      hp: 1,
      maxHp: 1,
      attack: 0,
      defense: 0,
      alive: true,
      aiState: null,
      targetId: null,
      attackCooldownMs: 0,
      heavyCooldownMs: 0,
    },
    container: { items: [] },
    claimedRewardIds: [],
  } as unknown as EntitySnapshot;
}

describe("planEntityVisualRebuild（切区重建实体视觉）", () => {
  it("上一区域的 NPC/敌人视觉被清掉，玩家保留", () => {
    const plan = planEntityVisualRebuild(
      [entity("entity:player", "player"), entity("enemy:den.core", "enemy")],
      new Set(["entity:player", "npc:elder_ma", "enemy:slime.a"]),
    );
    expect(plan.disposeIds.sort()).toEqual(["enemy:slime.a", "npc:elder_ma"]);
    expect(plan.disposeIds).not.toContain("entity:player");
  });

  it("新区域的 NPC/敌人都要重建视觉（巢穴敌人不能没有 visual）", () => {
    const plan = planEntityVisualRebuild(
      [
        entity("entity:player", "player"),
        entity("npc:den.watcher", "npc"),
        entity("enemy:den.brood", "enemy"),
      ],
      new Set(["entity:player", "npc:elder_ma", "npc:scout_lin", "enemy:slime.a"]),
    );
    expect(plan.create.map((entry) => entry.id).sort()).toEqual([
      "enemy:den.brood",
      "npc:den.watcher",
    ]);
  });

  it("快照里已不存在、但视觉表还挂着的陈旧 id 一并清掉", () => {
    const plan = planEntityVisualRebuild(
      [entity("entity:player", "player")],
      new Set(["entity:player", "enemy:ghost"]),
    );
    expect(plan.disposeIds).toEqual(["enemy:ghost"]);
    expect(plan.create).toHaveLength(0);
  });
});

describe("bushesOf（区域灌木缓存）", () => {
  it("只保留灌木，且不含其它字段（帧内不再重建列表）", () => {
    const bushes = bushesOf(PROPS);
    expect(bushes.every((bush) => bush.id.startsWith("prop.bush."))).toBe(true);
    expect(bushes.length).toBe(
      PROPS.filter((prop: PropPlacement) => prop.kind === "bush").length,
    );
  });

  it("巢穴布局的灌木列表独立于翠谷（随区域上下文切换）", () => {
    const hollow = bushesOf(PROPS);
    const den = bushesOf(SLIME_DEN_PROPS);
    for (const bush of hollow) {
      expect(den.some((entry) => entry.id === bush.id)).toBe(false);
    }
  });

  it("灌木坐标落在区域边界内（bounds 与布局同源）", () => {
    for (const bush of bushesOf(PROPS)) {
      expect(bush.x).toBeGreaterThan(GREEN_HOLLOW_BOUNDS.minX);
      expect(bush.x).toBeLessThan(GREEN_HOLLOW_BOUNDS.maxX);
    }
  });
});
