/**
 * 票 27：重击（heavyAttack）意图。
 *
 * 接缝 = GameSessionIntents.heavyAttack() 与 snapshot()：
 * - 倍率 1.5、冷却 8000ms 走属性系统（内容可用 heavyAttackMultiplier /
 *   heavyAttackCooldownMs 覆盖）；
 * - 未命中同样进入冷却（与普攻一致，避免冷却中反复刷重击）；
 * - 重击是「一次性意图」：结算后自动回到普攻；
 * - 走 A（moveTo）打断攻击意图，包括重击。
 */

import { describe, expect, it } from "vitest";

import type { ContentBundle } from "./content/types";
import { GameSession } from "./game-session";

const REGION_ID = "region:arena";
const PLAYER_ID = "entity:player";
const SLIME_ID = "enemy:slime";

/** 玩家 12 攻 / 4 防；史莱姆 24 血 1 防：普攻 11，重击 round(18×1.5)-1 = 26。 */
function combatBundle(): ContentBundle {
  return {
    regions: [
      {
        id: REGION_ID,
        displayName: "竞技场",
        asset: { model: "assets/regions/arena.glb" },
        player: {
          id: PLAYER_ID,
          templateId: "player_template:hero",
          displayName: "旅人",
          spawn: { position: { x: 0, y: 0, z: 0 } },
          baseAttributes: {
            maxHp: 100,
            hp: 100,
            attack: 12,
            defense: 4,
            moveSpeed: 5.5,
          },
        },
      },
    ],
    npcs: [],
    enemyTemplates: [
      {
        id: "enemy_template:slime",
        displayName: "史莱姆",
        aiProfileId: "ai:melee_chaser",
        baseAttributes: {
          maxHp: 30,
          hp: 30,
          attack: 0,
          defense: 1,
          moveSpeed: 0,
          xp: 0,
          aggroRadius: 0,
        },
        tags: ["enemy", "slime"],
      },
    ],
    enemies: [
      {
        id: SLIME_ID,
        templateId: "enemy_template:slime",
        displayName: "草原史莱姆",
        regionId: REGION_ID,
        position: { x: 1.5, y: 0, z: 0 },
        overrides: { baseAttributes: { maxHp: 200, hp: 200 } },
      },
    ],
    items: [],
    quests: [],
  };
}

function createSession(roll = 0): GameSession {
  const session = new GameSession({ random: () => roll });
  session.loadRegion(combatBundle(), REGION_ID);
  return session;
}

function entityOf(session: GameSession, id: string) {
  const entity = session.snapshot().entities.find((candidate) => candidate.id === id);
  if (!entity) {
    throw new Error(`快照中缺少实体 ${id}`);
  }
  return entity;
}

describe("GameSession 重击意图：倍率与冷却", () => {
  it("重击造成 1.5 倍伤害并广播 heavy=true", () => {
    const session = createSession();
    const events: string[] = [];
    const seen: Array<Record<string, unknown>> = [];
    session.subscribe((event) => {
      events.push(event.type);
      if (event.type === "damage-dealt") {
        seen.push(event as unknown as Record<string, unknown>);
      }
    });

    session.heavyAttack(PLAYER_ID, SLIME_ID);
    session.advance(600); // 重击前摇 600ms

    // round((12 - 1) × 1.5) = 17
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(183);
    expect(seen).toEqual([
      expect.objectContaining({ type: "damage-dealt", amount: 17, heavy: true }),
    ]);
  });

  it("重击冷却 8000ms：冷却期间不结算，推进到冷却结束才打出下一击", () => {
    const session = createSession();

    session.heavyAttack(PLAYER_ID, SLIME_ID); // 起手即锁重击冷却
    expect(entityOf(session, PLAYER_ID).combat.heavyCooldownMs).toBe(8000);
    // 普攻回合仍按 1000ms 间隔推进，不被重击冷却拖住。
    expect(entityOf(session, PLAYER_ID).combat.attackCooldownMs).toBe(1000);
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(200);

    session.advance(600); // 前摇结束，第一击 17
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(183);

    // 冷却中再按重击：显式拒绝（HUD 按钮此时也是 disabled）。
    expect(() => session.heavyAttack(PLAYER_ID, SLIME_ID)).toThrow(/冷却/);
    expect(session.tryHeavyAttack(PLAYER_ID, SLIME_ID).ok).toBe(false);

    session.advance(7400); // t=8000 冷却归零；期间普攻按 1s 间隔继续
    expect(entityOf(session, PLAYER_ID).combat.heavyCooldownMs).toBe(0);
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(95); // 183 - 8×11

    session.heavyAttack(PLAYER_ID, SLIME_ID); // 第二击意图
    session.advance(1000); // 普攻回合结束后起前摇（t=9000）
    session.advance(600); // t=9600 第二击落地
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(78); // 95 - 17
  });

  it("重击未命中也消耗冷却，且 damage-dealt 不广播", () => {
    const session = createSession(0.95); // 命中率 0.9 → 未命中
    const seen: string[] = [];
    session.subscribe((event) => {
      if (event.type === "damage-dealt") {
        seen.push(event.type);
      }
    });

    session.heavyAttack(PLAYER_ID, SLIME_ID);
    session.advance(600);

    expect(entityOf(session, SLIME_ID).combat.hp).toBe(200);
    expect(seen).toEqual([]);
    expect(entityOf(session, PLAYER_ID).combat.heavyCooldownMs).toBe(7400);
  });

  it("重击是一次性意图：第一击之后自动回到普攻", () => {
    const session = createSession();
    const heavyFlags: boolean[] = [];
    session.subscribe((event) => {
      if (event.type === "damage-dealt") {
        heavyFlags.push(event.heavy);
      }
    });

    session.heavyAttack(PLAYER_ID, SLIME_ID); // 起手
    session.advance(600); // 重击 17
    session.advance(400); // t=1000 自动回合回到普攻：11
    session.advance(1000); // 再一回合普攻：11

    expect(heavyFlags).toEqual([true, false, false]);
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(161); // 200 - 17 - 11 - 11
  });

  it("重击复用 attack 的校验：死亡目标与越界目标显式报错", () => {
    const session = createSession();
    expect(() => session.heavyAttack(PLAYER_ID, "enemy:missing")).toThrow(/未知实体/);
    expect(() => session.heavyAttack(PLAYER_ID, PLAYER_ID)).toThrow(/自己/);

    session.heavyAttack(PLAYER_ID, SLIME_ID);
    session.advance(100);
    expect(() => session.heavyAttack(PLAYER_ID, SLIME_ID)).toThrow(/冷却/);
  });

  it("重击内容属性可覆盖倍率与冷却（heavyAttackMultiplier / heavyAttackCooldownMs）", () => {
    const bundle = combatBundle();
    bundle.regions[0].player.baseAttributes.heavyAttackMultiplier = 2;
    bundle.regions[0].player.baseAttributes.heavyAttackCooldownMs = 4000;
    const session = new GameSession({ random: () => 0 });
    session.loadRegion(bundle, REGION_ID);

    session.heavyAttack(PLAYER_ID, SLIME_ID);
    expect(entityOf(session, PLAYER_ID).combat.heavyCooldownMs).toBe(4000);
    session.advance(600);

    // round((12 - 1) × 2) = 22
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(178);
  });

  it("tryHeavyAttack 把可预期失败转成结构化结果", () => {
    const session = createSession();
    const result = session.tryHeavyAttack(PLAYER_ID, "enemy:missing");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/未知实体/);
  });
});

describe("GameSession 走 A：移动打断攻击意图", () => {
  it("普攻意图下移动会取消攻击目标", () => {
    const session = createSession();

    session.attack(PLAYER_ID, SLIME_ID);
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(189);

    session.moveTo(PLAYER_ID, { x: 8, y: 0, z: 0 });
    session.advance(1000); // 冷却结束也不会再自动打

    expect(entityOf(session, PLAYER_ID).combat.targetId).toBeNull();
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(189);
  });

  it("重击意图下移动同样打断（风筝）", () => {
    const session = createSession();

    session.heavyAttack(PLAYER_ID, SLIME_ID); // 起手（前摇 600ms）
    session.moveTo(PLAYER_ID, { x: 8, y: 0, z: 0 }); // 走 A：前摇被打断
    session.advance(8000);

    expect(entityOf(session, PLAYER_ID).combat.targetId).toBeNull();
    expect(entityOf(session, SLIME_ID).combat.hp).toBe(200); // 前摇被取消，没有伤害落地
  });
});

describe("GameSession 攻击朝向", () => {
  it("角色攻击时转向目标", () => {
    const session = createSession();

    session.attack(PLAYER_ID, SLIME_ID); // 目标在 +X 方向 → yaw = atan2(1, 0) = π/2

    const player = entityOf(session, PLAYER_ID);
    expect(player.rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });

  it("重击同样在结算时面向目标", () => {
    const session = createSession();

    session.heavyAttack(PLAYER_ID, SLIME_ID);

    expect(entityOf(session, PLAYER_ID).rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });
});
